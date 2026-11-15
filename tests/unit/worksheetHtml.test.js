// Prepare Worksheet HTML: cleaning what the editor sends, fetching pasted web
// images safely, and keeping formatting when building the Word file.
const h = require('../../services/worksheetHtml');

describe('sanitizeWorksheetHtml', () => {
  test('keeps Word-style formatting', () => {
    const html = '<h2>Title</h2><p style="text-align:center;line-height:1.5"><span style="font-family:Arial;font-size:14pt;color:#ff0000;background-color:#ffff00">x</span></p>'
      + '<ul><li>a</li></ul><ol start="3"><li>b</li></ol><table border="1"><tbody><tr><td colspan="2" style="border:1px solid #000">c</td></tr></tbody></table>'
      + '<p><strong>b</strong> <em>i</em> <u>u</u></p>';
    expect(h.sanitizeWorksheetHtml(html)).toBe(html);
  });

  test('drops scripts, handlers, frames, styles that load things and javascript: links', () => {
    const out = h.sanitizeWorksheetHtml(
      '<p onmouseover="x()" style="color:red;background:url(https://evil/x.png)">a</p><script>x()</script><iframe></iframe>'
      + '<a href="javascript:x()">l</a><img src="https://ok.test/a.png" onerror="x()"><svg><script>x()</script></svg><style>p{}</style>',
    );
    expect(out).toBe('<p style="color:red">a</p><a>l</a><img src="https://ok.test/a.png" />');
  });

  test('images: http(s) and raster data: only', () => {
    expect(h.sanitizeWorksheetHtml('<img src="data:image/png;base64,AAAA">')).toBe('<img src="data:image/png;base64,AAAA" />');
    expect(h.sanitizeWorksheetHtml('<img src="data:image/svg+xml;base64,PHN2Zz4=">')).toBe('');
    expect(h.sanitizeWorksheetHtml('<img src="file:///etc/passwd">')).toBe('');
  });

  test('Office paste markup is dropped, its text kept', () => {
    expect(h.sanitizeWorksheetHtml('<p class="MsoNormal">Hi<o:p></o:p></p>')).toBe('<p>Hi</p>');
  });
});

describe('validateWorksheet / file names', () => {
  test('a file name is required on create, optional on update', () => {
    expect(h.validateWorksheet({ title: '  ', html: '' })).toBe('Enter a file name');
    expect(h.validateWorksheet({ title: 'ok', html: '<p/>' })).toBeNull();
    expect(h.validateWorksheet({ html: '<p/>' }, { requireTitle: false })).toBeNull();
    expect(h.validateWorksheet({ title: '', html: '<p/>' }, { requireTitle: false })).toBe('Enter a file name');
    expect(h.validateWorksheet({ title: 'ok', html: 5 })).toBe('html must be a string');
  });

  test('download names are safe for Windows/macOS', () => {
    expect(h.docxFileName('Fractions: practice/1?')).toBe('Fractions practice 1.docx');
    expect(h.docxFileName('   ')).toBe('Worksheet.docx');
  });
});

describe('fetching pasted web images', () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const imageRes = (type = 'image/png', body = Buffer.from([1, 2, 3])) => ({
    ok: true, status: 200, headers: { get: (k) => (k === 'content-type' ? type : null) }, arrayBuffer: async () => body,
  });

  test('private, loopback and metadata addresses are refused', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
      expect(h.isPrivateAddress(ip)).toBe(true);
    }
    expect(h.isPrivateAddress('8.8.8.8')).toBe(false);
    expect(await h.isPublicHttpUrl('http://localhost/a.png')).toBe(false);
    expect(await h.isPublicHttpUrl('ftp://example.com/a.png', publicLookup)).toBe(false);
    expect(await h.isPublicHttpUrl('https://intranet.test/a.png', async () => [{ address: '10.0.0.1' }])).toBe(false);
    expect(await h.isPublicHttpUrl('https://images.example.com/a.png', publicLookup)).toBe(true);
  });

  test('an image becomes a data: URI; a non-image is ignored', async () => {
    const ok = await h.fetchImageAsDataUri('https://images.example.com/a.png', { fetchImpl: async () => imageRes(), lookup: publicLookup });
    expect(ok).toBe('data:image/png;base64,AQID');
    const html = await h.fetchImageAsDataUri('https://images.example.com/a', { fetchImpl: async () => imageRes('text/html'), lookup: publicLookup });
    expect(html).toBeNull();
  });

  test('a redirect to a private address is not followed', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 302, headers: { get: (k) => (k === 'location' ? 'http://169.254.169.254/meta' : null) } }));
    const out = await h.fetchImageAsDataUri('https://images.example.com/a.png', { fetchImpl, lookup: publicLookup });
    expect(out).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('embedImages inlines what it can and leaves out the rest', async () => {
    const fetchImpl = async (url) => (url.includes('good') ? imageRes() : { ok: false, status: 404, headers: { get: () => null } });
    const out = await h.embedImages('<p><img src="https://x.test/good.png" /><img src="https://x.test/gone.png" /></p>', { fetchImpl, lookup: publicLookup });
    expect(out).toBe('<p><img src="data:image/png;base64,AQID" /></p>');
  });

  test('hostDataImages swaps data: images for uploaded URLs and survives failures', async () => {
    const upload = jest.fn(async (uri) => (uri.includes('AAAA') ? 'https://res.cloudinary.com/x/a.png' : Promise.reject(new Error('down'))));
    const out = await h.hostDataImages('<img src="data:image/png;base64,AAAA"><img src="data:image/png;base64,BBBB">', upload);
    expect(out).toBe('<img src="https://res.cloudinary.com/x/a.png"><img src="data:image/png;base64,BBBB">');
  });
});

describe('promoteInlineStyles (bold/italic set by style, e.g. Google Docs paste)', () => {
  test('font-weight/font-style become <b>/<i>', () => {
    expect(h.promoteInlineStyles('<p><span style="font-weight:700">B</span> <span style="font-style:italic">I</span></p>'))
      .toBe('<p><span style="font-weight:700"><b>B</b></span> <span style="font-style:italic"><i>I</i></span></p>');
  });

  test('Google Docs\' <b style="font-weight:normal"> wrapper does not make everything bold', () => {
    expect(h.promoteInlineStyles('<b style="font-weight:normal" id="docs-internal-guid-1"><p>plain</p></b>')).toBe('<p>plain</p>');
    expect(h.promoteInlineStyles('<p><b style="font-weight:normal">plain</b></p>')).toBe('<p><span style="font-weight:normal">plain</span></p>');
  });

  test('lists and tables are not wrapped', () => {
    const html = '<ul style="font-weight:bold"><li>a</li></ul>';
    expect(h.promoteInlineStyles(html)).toBe(html);
  });
});
