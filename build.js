// build.js — fetches Confluence page in markdown and injects into index.html
// Run: node build.js
// Requires: CONFLUENCE_EMAIL and CONFLUENCE_TOKEN env vars

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const HOST   = 'thryv.atlassian.net';
const PAGE   = '4281368617';
const EMAIL  = process.env.CONFLUENCE_EMAIL;
const TOKEN  = process.env.CONFLUENCE_TOKEN;

if (!EMAIL || !TOKEN) {
  console.error('❌  Set CONFLUENCE_EMAIL and CONFLUENCE_TOKEN');
  process.exit(1);
}

const AUTH = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

function get(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: HOST, path, headers: { Authorization: `Basic ${AUTH}`, Accept: 'application/json' } },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
          }
          resolve(JSON.parse(body));
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  console.log('🔄  Fetching from Confluence…');

  // Use the v2 API with "atlas_doc_format" to get structured content
  // Then fall back to getting the body via the wiki REST API with body.atlas_doc_format
  let markdown = '';
  let updatedAt = new Date().toISOString();
  let version = 0;

  try {
    // Try the /wiki/rest/api endpoint with body.export_view
    const data = await get(`/wiki/rest/api/content/${PAGE}?expand=body.atlas_doc_format,version`);
    updatedAt = data.version.when;
    version   = data.version.number;

    // Walk the ADF document and extract text
    markdown = adfToMarkdown(data.body.atlas_doc_format.value);
    console.log(`✅  Got v${version}, updated ${updatedAt}`);
  } catch (e) {
    console.error('❌  Failed:', e.message);
    process.exit(1);
  }

  // Count members as a sanity check
  const memberCount = (markdown.match(/\*\*Team Members \(FTE\):\*\*/g) || []).length;
  console.log(`📊  Found ${memberCount} team member sections in markdown`);

  if (memberCount === 0) {
    console.warn('⚠️  No member sections found — dumping first 2000 chars:');
    console.log(markdown.slice(0, 2000));
  }

  // Build the output file
  const tmpl = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const data = JSON.stringify({ page: { body: markdown }, updatedAt, version });
  const out  = tmpl.replace(
    'const CONFLUENCE_DATA = window.__CONFLUENCE_DATA__ || null;',
    `window.__CONFLUENCE_DATA__ = ${data};\nconst CONFLUENCE_DATA = window.__CONFLUENCE_DATA__ || null;`
  );

  fs.mkdirSync(path.join(__dirname, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'docs', 'index.html'), out);
  console.log('📄  Written to docs/index.html');
}

// ── ADF (Atlassian Document Format) → Markdown ────────────────────────────
// ADF is a JSON tree. We walk it and emit markdown.
function adfToMarkdown(adfJson) {
  let doc;
  try {
    doc = typeof adfJson === 'string' ? JSON.parse(adfJson) : adfJson;
  } catch {
    return '';
  }

  const lines = [];

  function nodeText(node) {
    if (!node) return '';
    if (node.type === 'text') {
      let t = node.text || '';
      if (node.marks) {
        for (const m of node.marks) {
          if (m.type === 'strong') t = `**${t}**`;
          if (m.type === 'em')     t = `_${t}_`;
        }
      }
      return t;
    }
    return (node.content || []).map(nodeText).join('');
  }

  function walkNode(node, depth) {
    if (!node) return;
    const t = node.type;

    if (t === 'heading') {
      const lvl = node.attrs?.level || 2;
      const text = (node.content || []).map(nodeText).join('');
      lines.push(`${'#'.repeat(lvl)} ${text}`);
      return;
    }

    if (t === 'paragraph') {
      const text = (node.content || []).map(nodeText).join('');
      if (text.trim()) lines.push(text);
      return;
    }

    if (t === 'table') {
      const rows = (node.content || []).filter(n => n.type === 'tableRow');
      for (const row of rows) {
        const cells = (row.content || []).map(cell => {
          return (cell.content || []).map(p => (p.content || []).map(nodeText).join('')).join(' ').trim();
        });
        lines.push('| ' + cells.join(' | ') + ' |');
      }
      lines.push('');
      return;
    }

    if (t === 'bulletList' || t === 'orderedList') {
      for (const item of (node.content || [])) {
        const text = (item.content || []).map(p => (p.content || []).map(nodeText).join('')).join(' ').trim();
        lines.push(`- ${text}`);
      }
      return;
    }

    if (t === 'rule') { lines.push('---'); return; }

    if (t === 'panel' || t === 'blockquote') {
      // Info panels are used for "being redistributed" notices
      const text = (node.content || []).map(n => (n.content||[]).map(nodeText).join('')).join(' ');
      if (text.toLowerCase().includes('distribut')) {
        lines.push('_**This team is being re-distributed**_');
      }
      return;
    }

    // Default: recurse into children
    for (const child of (node.content || [])) {
      walkNode(child, depth + 1);
    }
  }

  for (const node of (doc.content || [])) {
    walkNode(node, 0);
  }

  return lines.join('\n');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
