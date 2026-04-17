// build.js — fetches Confluence page and injects data into index.html
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

// ── 1. Fetch page (storage format = raw HTML-like XML) ─────────────────────
function fetchPage() {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: CONFLUENCE_BASE,
      path: `/wiki/rest/api/content/${PAGE_ID}?expand=body.storage,version`,
      headers: { Authorization: `Basic ${AUTH}`, Accept: 'application/json' },
    };
    https.get(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
        resolve(JSON.parse(raw));
      });
    }).on('error', reject);
  });
}

// ── 2. Strip all XML/HTML tags, decode entities ────────────────────────────
function strip(s) {
  return (s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g,  "'")
    .replace(/&quot;/g, '"')
    .trim();
}

// ── 3. Convert Confluence storage XML → simple markdown ───────────────────
// Strategy: walk headings and tables only — everything else is noise.
function storageToMarkdown(xml) {
  const lines = [];

  // Replace heading tags with ## / ###
  xml = xml
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n## ${strip(t)}\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `\n### ${strip(t)}\n`)
    .replace(/<strong>([\s\S]*?)<\/strong>/gi, (_, t) => `**${strip(t)}**`)
    .replace(/<em>([\s\S]*?)<\/em>/gi, (_, t) => `_${strip(t)}_`);

  // Convert tables: each <tr> → pipe-delimited row
  xml = xml.replace(/<table[\s\S]*?<\/table>/gi, table => {
    const rows = [];
    const trRe = /<tr[\s\S]*?<\/tr>/gi;
    let trMatch;
    while ((trMatch = trRe.exec(table)) !== null) {
      const cells = [];
      const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let tdMatch;
      while ((tdMatch = tdRe.exec(trMatch[0])) !== null) {
        cells.push(strip(tdMatch[1]));
      }
      if (cells.length) rows.push('| ' + cells.join(' | ') + ' |');
    }
    return '\n' + rows.join('\n') + '\n';
  });

  // Collapse panel/info macros that signal "being redistributed"
  xml = xml.replace(/<ac:structured-macro[^>]*name="info"[\s\S]*?<\/ac:structured-macro>/gi,
    '\n_**This team is being re-distributed**_\n');

  // Strip all remaining tags
  return xml.replace(/<[^>]+>/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── 4. Parse markdown into GROUPS array ───────────────────────────────────
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
    if (!line) continue;

    // H2 → group
    if (line.startsWith('## ')) {
      const title = line.slice(3).trim();
      if (GROUP_META[title]) {
        grp = { name: title, ...GROUP_META[title], steeringPM:'—', steeringTech:'—', teams:[] };
        groups.push(grp);
        team = null; inMembers = false;
      }
      continue;
    }

    // Steering info
    if (line.includes('Steering PM:') && grp) {
      const pm = (line.match(/Steering PM:\*\*\s*([^|*\n]+)/)||[])[1]||'';
      grp.steeringPM = pm.trim() || grp.steeringPM;
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

    // Table rows
    if (line.startsWith('|') && !line.includes('---')) {
      const cells = line.split('|').slice(1,-1).map(c => c.trim());
      if (cells.length < 2 || !cells[0]) continue;

      const role = cells[0].replace(/\*\*/g,'').toLowerCase();
      const name = cells[1].replace(/\*\*/g,'').trim();

      // Role assignment rows (before member section)
      if (!inMembers) {
        if (role.includes('product manager') && !role.includes('program')) team.pm = name;
        else if (role.includes('program manager'))   team.pgm = name;
        else if (role === 'engineering manager')      team.em = name;
        else if (role === 'engineering lead')         team.engLead = name;
        else if (role === 'tech lead')                team.techLead = name;
        else if (role.includes('design lead') || role === 'design') team.design = name;
        else if (role.includes('content design'))     team.content = name;
        else if (role.includes('ux research'))        team.ux = name;
        // Member rows inside role table (name / moved-to format for redistribution)
        else if (team.redistributing && name && role !== 'name' && role !== '**name**') {
          team.members.push({ name: cells[0].replace(/\*\*/g,'').trim(), title:'', ctrct:false, moved: name });
        }
        continue;
      }

      // Inside member/contractor table
      if (inMembers) {
        const rawName = cells[0].replace(/\*\*/g,'').trim();
        const title   = cells[1] || '';
        if (!rawName || rawName.toLowerCase() === 'name') continue;
        const isCtrct = rawName.toUpperCase().includes('CTRCT');
        const cleanName = rawName.replace(/^CTRCT\s*[-–]\s*/i,'').trim();
        if (cleanName) team.members.push({ name: cleanName, title, ctrct: isCtrct });
      }
      continue;
    }

    // Section headers that signal member tables follow
    if (line.includes('Team Members (FTE)') || line === '**Contractors:**' || line.startsWith('**Contractors')) {
      inMembers = true; continue;
    }

    // Moved-to table header for redistribution teams
    if (team.redistributing && line.includes('Moved to')) {
      inMembers = true; continue;
    }
  }
  return groups;
}

// ── 5. Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔄  Fetching Confluence page…');
  const page = await fetchPage();

  const storage   = page.body.storage.value;
  const markdown  = storageToMarkdown(storage);
  const groups    = parseMarkdown(markdown);
  const updatedAt = page.version.when;
  const version   = page.version.number;

  // Sanity check
  const totalMembers = groups.reduce((a,g)=>a+g.teams.reduce((b,t)=>b+t.members.length,0),0);
  console.log(`✅  v${version} · ${groups.length} groups · ${groups.reduce((a,g)=>a+g.teams.length,0)} teams · ${totalMembers} members`);

  if (totalMembers === 0) {
    console.warn('⚠️  No members parsed — check the storage format output.');
    // Dump first 3000 chars of converted markdown for debugging
    console.log('--- MARKDOWN SAMPLE ---');
    console.log(markdown.slice(0, 3000));
    console.log('--- END SAMPLE ---');
  }

  // Inject into index.html
  const tmpl = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const injection = `window.__CONFLUENCE_DATA__ = ${JSON.stringify({ page:{ body: markdown }, updatedAt, version })};`;
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
