// build.js — fetches Confluence page (markdown format) and injects into index.html
// Run: node build.js
// Requires env vars: CONFLUENCE_EMAIL, CONFLUENCE_TOKEN

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const CONFLUENCE_BASE = 'thryv.atlassian.net';
const PAGE_ID         = '4281368617';
const EMAIL           = process.env.CONFLUENCE_EMAIL;
const TOKEN           = process.env.CONFLUENCE_TOKEN;

if (!EMAIL || !TOKEN) {
  console.error('❌  Missing CONFLUENCE_EMAIL or CONFLUENCE_TOKEN');
  process.exit(1);
}

const AUTH = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

function fetchPage() {
  return new Promise((resolve, reject) => {
    // Use the v2 API with markdown body format
    const opts = {
      hostname: CONFLUENCE_BASE,
      path: `/wiki/api/v2/pages/${PAGE_ID}?body-format=atlas_doc_format`,
      headers: { Authorization: `Basic ${AUTH}`, Accept: 'application/json' },
    };
    https.get(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0,500)}`));
        resolve(JSON.parse(raw));
      });
    }).on('error', reject);
  });
}

// Fetch page using v1 API with expand for body in export_view (closest to markdown)
function fetchPageV1() {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: CONFLUENCE_BASE,
      path: `/wiki/rest/api/content/${PAGE_ID}?expand=body.export_view,version`,
      headers: { Authorization: `Basic ${AUTH}`, Accept: 'application/json' },
    };
    https.get(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0,500)}`));
        resolve(JSON.parse(raw));
      });
    }).on('error', reject);
  });
}

// ── Strip HTML tags and decode entities ────────────────────────────────────
function strip(s) {
  return (s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g,  "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Convert export_view HTML → markdown ───────────────────────────────────
function htmlToMarkdown(html) {
  let md = html;

  // Headings
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `\n# ${strip(t)}\n`);
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n## ${strip(t)}\n`);
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `\n### ${strip(t)}\n`);

  // Bold
  md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, (_, t) => `**${strip(t)}**`);
  md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi,           (_, t) => `**${strip(t)}**`);
  md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi,         (_, t) => `_${strip(t)}_`);

  // Info/note macros → redistribution marker
  md = md.replace(/<div[^>]*class="[^"]*confluence-information-macro[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    '\n_**This team is being re-distributed**_\n');

  // Tables — extract row by row
  md = md.replace(/<table[\s\S]*?<\/table>/gi, tableHtml => {
    const rows = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trM;
    while ((trM = trRe.exec(tableHtml)) !== null) {
      const cells = [];
      const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let tdM;
      while ((tdM = tdRe.exec(trM[1])) !== null) {
        cells.push(strip(tdM[1]));
      }
      if (cells.length) rows.push('| ' + cells.join(' | ') + ' |');
    }
    return '\n' + rows.join('\n') + '\n';
  });

  // Paragraphs / divs → newlines
  md = md.replace(/<\/?(p|div|li|ul|ol)[^>]*>/gi, '\n');

  // Strip remaining tags
  md = md.replace(/<[^>]+>/g, '');

  // Decode remaining entities
  md = md
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g,  "'")
    .replace(/&quot;/g, '"');

  // Clean up whitespace
  return md.replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Parse markdown into GROUPS array ──────────────────────────────────────
const GROUP_META = {
  'Cohorts / Migration':  { color:'#185FA5', bgColor:'#ddeaf7' },
  'Thryv 2.0':            { color:'#534AB7', bgColor:'#e8e7f8' },
  'Thryv Leads':          { color:'#0F6E56', bgColor:'#d5ede5' },
  'Social Ads':           { color:'#D85A30', bgColor:'#f5ddd3' },
  'SEO':                  { color:'#993556', bgColor:'#f2d8e3' },
  'Shared Services':      { color:'#BA7517', bgColor:'#f5e6c8' },
  'DevSecOps':            { color:'#A32D2D', bgColor:'#f5d5d5' },
  'Capture & Engage':     { color:'#3B6D11', bgColor:'#d8eac4', growOrg:true },
  'Convert':              { color:'#5F5E5A', bgColor:'#e8e6e0', growOrg:true },
  'Ecosystem & Platform': { color:'#993C1D', bgColor:'#f5ddd3', growOrg:true },
};

function parseMarkdown(md) {
  const groups = [];
  let grp = null, team = null, inMembers = false;

  for (const rawLine of md.split('\n')) {
    const line = rawLine.trim();
    if (!line) { continue; }

    // H2 → possible group
    if (line.startsWith('## ')) {
      const title = line.slice(3).trim();
      if (GROUP_META[title]) {
        grp = { name:title, ...GROUP_META[title], steeringPM:'—', steeringTech:'—', teams:[] };
        groups.push(grp);
        team = null; inMembers = false;
      }
      continue;
    }

    // H3 → team
    if (line.startsWith('### ') && grp) {
      team = { name: line.slice(4).trim(), members:[], redistributing:false };
      grp.teams.push(team);
      inMembers = false;
      continue;
    }

    if (!team) continue;

    // Redistribution flag
    if (line.toLowerCase().includes('re-distribut')) {
      team.redistributing = true; continue;
    }

    // Member section headers
    if (line.includes('Team Members (FTE)') || line.startsWith('**Contractors')) {
      inMembers = true; continue;
    }

    // Table rows
    if (line.startsWith('|')) {
      // Skip separator rows
      if (line.includes('---')) continue;

      const cells = line.split('|').slice(1,-1).map(c => c.trim());
      if (cells.length < 1 || !cells[0]) continue;

      const col0 = cells[0].replace(/\*\*/g,'').trim();
      const col1 = (cells[1] || '').replace(/\*\*/g,'').trim();

      if (!inMembers) {
        // Role assignment rows
        const role = col0.toLowerCase();
        if (role === 'role' || role === 'name') continue; // header row
        if (role.includes('product manager') && !role.includes('program')) team.pm = col1;
        else if (role.includes('program manager'))  team.pgm = col1;
        else if (role === 'engineering manager')     team.em = col1;
        else if (role === 'engineering lead')        team.engLead = col1;
        else if (role === 'tech lead')               team.techLead = col1;
        else if (role.includes('design lead') || role === 'design') team.design = col1;
        else if (role.includes('content design'))    team.content = col1;
        else if (role.includes('ux research'))       team.ux = col1;
        // Redistribution destination rows: col0=name, col1=destination
        else if (team.redistributing && col0 && col1 && role !== 'name') {
          team.members.push({ name: col0, title:'', ctrct:false, moved: col1 });
        }
      } else {
        // Member rows
        if (!col0 || col0.toLowerCase() === 'name') continue;
        const isCtrct = col0.toUpperCase().includes('CTRCT');
        const cleanName = col0.replace(/^CTRCT\s*[-–]\s*/i,'').trim();
        if (cleanName) team.members.push({ name: cleanName, title: col1, ctrct: isCtrct });
      }
      continue;
    }
  }
  return groups;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔄  Fetching Confluence page (export_view)…');
  const page = await fetchPageV1();

  const rawHtml   = page.body.export_view.value;
  const markdown  = htmlToMarkdown(rawHtml);
  const updatedAt = page.version.when;
  const version   = page.version.number;

  const groups = parseMarkdown(markdown);
  const totalMembers = groups.reduce((a,g)=>a+g.teams.reduce((b,t)=>b+t.members.length,0),0);

  console.log(`✅  v${version} | ${groups.length} groups | ${groups.reduce((a,g)=>a+g.teams.length,0)} teams | ${totalMembers} members`);

  if (totalMembers === 0) {
    console.warn('⚠️  0 members parsed — dumping markdown sample for debugging:');
    console.log(markdown.slice(0, 4000));
  }

  // Build output HTML
  const tmpl = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const injection = `window.__CONFLUENCE_DATA__ = ${JSON.stringify({
    page: { body: markdown },
    updatedAt,
    version,
  })};`;

  const out = tmpl.replace(
    'const CONFLUENCE_DATA = window.__CONFLUENCE_DATA__ || null;',
    injection + '\nconst CONFLUENCE_DATA = window.__CONFLUENCE_DATA__ || null;'
  );

  const outDir = path.join(__dirname, 'docs');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), out, 'utf8');
  console.log(`📄  Written → docs/index.html`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
