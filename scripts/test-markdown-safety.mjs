// Regression test for the markdown renderer's HTML-safety contract.
//
// frontend/src/markdown.js is injected with innerHTML on the app's own
// origin (frontend/src/components/chat/transcript.js), so anything it
// emits is live DOM with the user's session attached. Two classes of
// defect used to get through:
//
//   1. Step 10 restored backslash-escaped characters verbatim *after*
//      the HTML-escape pass had already run, so `\<img src=x
//      onerror=alert(1)>` rendered a real <img> and `\"` closed the href
//      attribute of a generated anchor.
//   2. Link/image targets were never scheme-checked, so
//      `[x](javascript:alert(1))` produced a live script href.
//
// Rather than string-matching the output, this test parses the rendered
// HTML into tags/attributes and asserts the invariants that actually
// matter: only the renderer's own tags appear, no attribute outside its
// allowlist appears, and no URL-bearing attribute resolves to a scheme
// that can execute script.

import assert from 'node:assert/strict';

const { renderMarkdown } = await import('../frontend/src/markdown.js');

// ---- Minimal tag/attribute parser -------------------------------------

const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol',
  'li', 'label', 'input', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img'
]);
const ALLOWED_ATTRS = new Set([
  'href', 'src', 'alt', 'target', 'rel', 'class', 'loading', 'type',
  'disabled', 'checked', 'style'
]);
const URL_ATTRS = new Set(['href', 'src']);
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'ftp', 'ftps']);

function parseTags(html) {
  const tags = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\s*\/?>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const [, closing, name, rawAttrs] = m;
    const attrs = [];
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(rawAttrs)) !== null) attrs.push([a[1].toLowerCase(), a[2]]);
    // Anything in the attribute region that is not a quoted name=value
    // pair is an unquoted/valueless attribute — record it so the
    // allowlist still sees it. The self-closing slash is not an attribute.
    const leftover = rawAttrs.replace(attrRe, '').replace(/\/\s*$/, '').trim();
    for (const name of leftover.split(/\s+/)) {
    if (name) attrs.push([name.toLowerCase(), '']);
    }
    tags.push({ closing: closing === '/', name: name.toLowerCase(), attrs });
  }
  return tags;
}

// Decode the entities the renderer emits so a URL is checked in the form
// a browser would actually use it.
function decodeEntities(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function schemeOf(value) {
  // Browsers ignore control characters and whitespace when resolving a
  // scheme, so "java\tscript:alert(1)" still executes.
  const collapsed = decodeEntities(value).replace(/[\u0000-\u0020\u007F]+/g, '');
  const colon = collapsed.indexOf(':');
  if (colon === -1) return '';
  const prefix = collapsed.slice(0, colon);
  if (/[/?#]/.test(prefix)) return '';
  return /^[a-z][a-z0-9+.-]*$/i.test(prefix) ? prefix.toLowerCase() : '';
}

// assertInert(html, label) — the renderer's safety contract.
function assertInert(html, label) {
  const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\s*\/?>/g;
  for (const tag of parseTags(html)) {
    assert.ok(ALLOWED_TAGS.has(tag.name), `${label}: unexpected tag <${tag.name}> in ${html}`);
    for (const [name, value] of tag.attrs) {
      assert.ok(!name.startsWith('on'), `${label}: event handler ${name} in ${html}`);
      assert.ok(ALLOWED_ATTRS.has(name), `${label}: unexpected attribute ${name} in ${html}`);
      if (URL_ATTRS.has(name)) {
        const scheme = schemeOf(value);
        assert.ok(
          !scheme || SAFE_SCHEMES.has(scheme),
          `${label}: unsafe ${name} scheme "${scheme}" in ${html}`
        );
      }
    }
  }
  // Every literal angle bracket left after removing the tags the parser
  // recognised is live markup the parser could not see — an injected
  // `<img …>` in text, for example, whose only `>` is a later tag's.
  // Escaped text never contains a literal `<`, so this is exact.
  const residue = html.replace(TAG_RE, '');
  assert.ok(!/[<>]/.test(residue), `${label}: unparsed markup residue in ${html}`);
}

// ---- Payloads ---------------------------------------------------------

// Model output (or tool output the model quoted) must never become live
// markup or a script URL, however it is escaped or entity-encoded.
const PAYLOADS = [
  '\\<img src=x onerror=alert(1)>',
  '\\<script>alert(1)\\</script>',
  '\\<iframe src=//evil.example></iframe>',
  '\\<svg/onload=alert(1)>',
  '\\<b>bold\\</b>',
  '[click](javascript:alert(document.cookie))',
  '[click](JaVaScRiPt:alert(1))',
  '[click](java\tscript:alert(1))',
  '[click](vbscript:msgbox(1))',
  '[click](data:text/html,<script>alert(1)</script>)',
  '[click](&#106;avascript:alert(1))',
  '[click](javascript&colon;alert(1))',
  '[click](java&Tab;script:alert(1))',
  '[x](https://a\\" onmouseover=alert(1) z)',
  '[x](https://a\\"onmouseover=alert(1))',
  '![a](x\\" onerror=\\"alert(1))',
  '![a](javascript:alert(1))',
  '![a](data:image/svg+xml,<svg onload=alert(1)>)',
  '> \\<img src=x onerror=alert(1)>',
  '\\<img src=x onerror=alert(1)>',
  '| \\<img src=x onerror=alert(1)> | b |\n| --- | --- |\n| c | d |',
  '# \\<img src=x onerror=alert(1)>',
  '- \\<img src=x onerror=alert(1)>',
  '1. \\<img src=x onerror=alert(1)>',
  '\\<img src=x onerror=alert(1)>',
  '\\" onmouseover=\\"alert(1)',
  '`\\<img src=x onerror=alert(1)>`'
];

// ---- Cases ------------------------------------------------------------

let failures = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`  ok   - ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL - ${label}`);
    console.log(`         ${e.message.split('\n')[0]}`);
  }
};

// 1. Every payload renders inert, in every block context. The parser
//    above is what decides: a breakout would show up as either a tag the
//    renderer never emits or an attribute it never emits (an `on*`
//    handler, an injected `src`, ...).
for (let i = 0; i < PAYLOADS.length; i++) {
  const src = PAYLOADS[i];
  check(`payload #${i} stays inert: ${JSON.stringify(src.slice(0, 48))}`, () => {
    assertInert(renderMarkdown(src), 'payload');
  });
}

// 2. Multi-line prose mixing payloads with legitimate markup.
check('mixed prose stays inert', () => {
  const html = renderMarkdown([
    'Here is **bold** and a [link](https://example.com/a?x=1&y=2).',
    '',
    '```js',
    'const evil = "\\<img src=x onerror=alert(1)>";',
    '```',
    '',
    '> \\<img src=x onerror=alert(1)>',
    '',
    '| a | b |',
    '| --- | --- |',
    '| \\<img src=x onerror=alert(1)> | [x](javascript:alert(1)) |',
    '',
    '```',
    '\\<img src=x onerror=alert(1)>',
    '```'
  ].join('\n'));
  assertInert(html, 'mixed');
});

// 3. The escaping fix must not break literal characters. A backslash
//    escape still renders the character the author wrote.
check('backslash escapes still render literally', () => {
  const out = renderMarkdown('\\*not italic\\* and \\<tag\\> and \\"quote\\"');
  assert.ok(out.includes('*not italic*'), out);
  assert.ok(out.includes('&lt;tag&gt;'), out);
  assert.ok(out.includes('&quot;quote&quot;'), out);
  assertInert(out, 'escapes');
});

// 4. Legitimate links, images, autolinks and relative targets still work.
check('legitimate URLs are preserved', () => {
  const cases = [
    ['[x](https://example.com/a?b=1&c=2)', 'href="https://example.com/a?b=1&amp;c=2"'],
    ['[x](http://example.com)', 'href="http://example.com"'],
    ['[x](mailto:a@b.com)', 'href="mailto:a@b.com"'],
    ['[x](./relative.md)', 'href="./relative.md"'],
    ['[x](#anchor)', 'href="#anchor"'],
    ['![alt](https://example.com/i.png)', 'src="https://example.com/i.png"'],
    ['![alt](./images/i.png)', 'src="./images/i.png"'],
    ['see https://example.com/c', 'href="https://example.com/c"']
  ];
  for (const [src, expected] of cases) {
    const html = renderMarkdown(src);
    assert.ok(html.includes(expected), `${src} → ${html} (missing ${expected})`);
    assertInert(html, src);
  }
});

// 5. The app's own SPA routes stay plain text (the "auto-redirect" bug).
check('SPA routes are never linked', () => {
  for (const src of [
    '[x](http://127.0.0.1:5732/#/chat/abc)',
    '[x](/#/chat/abc)',
    '![x](/#/chat/abc)',
    'go to http://127.0.0.1:5732/#/chat/abc now'
  ]) {
    const html = renderMarkdown(src);
    assert.ok(!html.includes('<a href="http://127.0.0.1:5732/#/'), src + ' → ' + html);
    assert.ok(!html.includes('<a href="/#/'), src + ' → ' + html);
    assertInert(html, src);
  }
});

// 6. Markdown features that must keep working.
check('feature syntax still renders', () => {
  const out = renderMarkdown([
    '# Heading',
    '',
    '**bold** *italic* ~~strike~~ `code`',
    '',
    '- [ ] todo',
    '- [x] done',
    '',
    '1. first',
    '',
    '---',
    '',
    '| a | b |',
    '| :--- | ---: |',
    '| 1 | 2 |'
  ].join('\n'));
  for (const needle of ['<h1>Heading</h1>', '<strong>bold</strong>', '<em>italic</em>',
    '<del>strike</del>', '<code>code</code>', 'type="checkbox"', '<ol>', '<hr>',
    '<table>', '<th style="text-align:left">a</th>', '<td style="text-align:right">2</td>']) {
    assert.ok(out.includes(needle), `missing ${needle} in ${out}`);
  }
  assertInert(out, 'features');
});

// 7. Fenced code blocks are never interpreted as markup, whatever the
//    info string contains.
check('code fences escape both body and language', () => {
  const out = renderMarkdown('```\\"><img src=x onerror=alert(1)>\n\\<img src=x onerror=alert(1)>\n```');
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'), out);
  assertInert(out, 'fence');
});

console.log(`\n${PAYLOADS.length + 6} checks, ${failures} failed`);
if (failures) process.exitCode = 1;
