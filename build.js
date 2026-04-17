// build.js
// Fetches the Confluence page and injects the data into index.html
// Run: node build.js
// Requires env vars: CONFLUENCE_TOKEN, CONFLUENCE_EMAIL

const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFLUENCE_BASE  = 'thryv.atlassian.net';
const CONFLUENCE_PAGE  = '4281368617';
const CONFLUENCE_EMAIL = process.env.CONFLUENCE_EMAIL;
const CONFLUENCE_TOKEN = process.env.CONFLUENCE_TOKEN;

if (!CONFLUENCE_EMAIL || !CONFLUENCE_TOKEN) {
  console.error('❌  Missing CONFLUENCE_EMAIL or CONFLUENCE_TOKEN env vars');
  process.exit(1);
}

const auth = Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_TOKEN}`).toString('base64');

function fetchPage() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: CONFLUENCE_BASE,
      path: `/wiki/rest/api/content/${CONFLUENCE_PAGE}?expand=body.storage,version`,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
      },
    };
    https.get(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Confluence returned ${res.statusCode}: ${data}`));
        } else {
          resolve(JSON.parse(data));
        }
      });
    }).on('error', reject);
  });
}

// Confluence returns storage format (XML-like). Convert basic tags to markdown.
function storageToMarkdown(html) {
  return html
    .replace(/<h2[^>]*>(.*?)<\/h2>/g,      (_, t) => `\n## ${stripTags(t)}\n`)
    .replace(/<h3[^>]*>(.*?)<\/h3>/g,      (_, t) => `\n### ${stripTags(t)}\n`)
    .replace(/<strong>(.*?)<\/strong>/g,    (_, t) => `**${t}**`)
    .replace(/<em>(.*?)<\/em>/g,            (_, t) => `_${t}_`)
    .replace(/<tr>/g, '\n|').replace(/<\/tr>/g, '')
    .replace(/<t[dh][^>]*>(.*?)<\/t[dh]>/g,(_, t) => ` ${stripTags(t)} |`)
    .replace(/<[^>]+>/g, '')               // strip remaining tags
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

function stripTags(s) { return s.replace(/<[^>]+>/g,'').trim(); }

async function main() {
  console.log('🔄  Fetching Confluence page…');
  const page = await fetchPage();

  const rawHtml = page.body.storage.value;
  const markdown = storageToMarkdown(rawHtml);
  const updatedAt = page.version.when;

  console.log(`✅  Got page v${page.version.number}, last updated ${updatedAt}`);

  // Read template
  const templatePath = path.join(__dirname, 'index.html');
  let html = fs.readFileSync(templatePath, 'utf8');

  // Inject data
  const injection = `window.__CONFLUENCE_DATA__ = ${JSON.stringify({
    page: { body: markdown },
    updatedAt,
    version: page.version.number,
  })};`;

  html = html.replace(
    'const CONFLUENCE_DATA = window.__CONFLUENCE_DATA__ || null;',
    injection + '\nconst CONFLUENCE_DATA = window.__CONFLUENCE_DATA__ || null;'
  );

  const outPath = path.join(__dirname, 'docs', 'index.html');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`📄  Written to ${outPath}`);
}

main().catch(err => {
  console.error('❌ Build failed:', err.message);
  process.exit(1);
});
