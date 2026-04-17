// build.js — fetches Confluence, parses into structured JSON, injects into index.html
// Run: node build.js
// Requires: CONFLUENCE_EMAIL and CONFLUENCE_TOKEN env vars

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const HOST  = 'thryv.atlassian.net';
const PAGE  = '4281368617';
const EMAIL = process.env.CONFLUENCE_EMAIL;
const TOKEN = process.env.CONFLUENCE_TOKEN;

if (!EMAIL || !TOKEN) {
  console.error('❌  Set CONFLUENCE_EMAIL and CONFLUENCE_TOKEN');
  process.exit(1);
}

const AUTH = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: HOST, path: urlPath, headers: { Authorization: `Basic ${AUTH}`, Accept: 'application/json' } },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          if (res.statusCode < 200 || res.statusCode >= 300)
            return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0,400)}`));
          resolve(JSON.parse(body));
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ── Strip HTML tags, decode entities ──────────────────────────────────────
function clean(s) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
}

// ── Parse HTML table → array of {role, name, title} rows ──────────────────
function parseTable(html) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trM;
  while ((trM = trRe.exec(html)) !== null) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let tdM;
    while ((tdM = tdRe.exec(trM[1])) !== null) cells.push(clean(tdM[1]));
    if (cells.length >= 2 && cells[0] && cells[0].toLowerCase() !== 'role' && cells[0].toLowerCase() !== 'name') {
      rows.push(cells);
    }
  }
  return rows;
}

// ── Color/meta config per group ────────────────────────────────────────────
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

// ── Parse the export_view HTML into structured GROUPS ──────────────────────
function parseHTML(html) {
  const groups = [];
  let grp = null, team = null;

  // Split on h2 and h3 tags to get sections
  // We'll walk through the HTML looking for headings and tables

  // Extract all sections by splitting on heading tags
  const sectionRe = /<(h[23])[^>]*>([\s\S]*?)<\/h[23]>([\s\S]*?)(?=<h[23]|$)/gi;
  let m;

  while ((m = sectionRe.exec(html)) !== null) {
    const level = m[1]; // h2 or h3
    const titleRaw = clean(m[2]);
    const body = m[3];

    if (level === 'h2') {
      if (GROUP_META[titleRaw]) {
        grp = { name: titleRaw, ...GROUP_META[titleRaw], steeringPM: '—', steeringTech: '—', teams: [] };
        groups.push(grp);
        team = null;
      }
      // Extract steering info from body text
      if (grp) {
        const pmM = body.match(/Steering PM[^:]*:\s*<\/strong>\s*([^<|]+)/i) ||
                    body.match(/Steering PM[^:]*:\*\*\s*([^|*\n<]+)/i);
        if (pmM) grp.steeringPM = pmM[1].trim();
      }
      continue;
    }

    if (level === 'h3' && grp) {
      team = { name: titleRaw, members: [], redistributing: false };
      grp.teams.push(team);

      // Check for redistribution notice
      if (body.toLowerCase().includes('re-distribut') || body.toLowerCase().includes('being redistributed')) {
        team.redistributing = true;
      }

      // Parse all tables in this section's body
      const tableRe = /<table[\s\S]*?<\/table>/gi;
      let tM;
      let foundMemberTable = false;

      while ((tM = tableRe.exec(body)) !== null) {
        const tableHTML = tM[0];
        const rows = parseTable(tableHTML);
        if (!rows.length) continue;

        // Determine if this is a role table or member table
        // Role tables have "Role" as first col; member tables have "Name" as first col
        const firstRow = rows[0];
        const isRoleTable = firstRow.length >= 2 &&
          !['michael','jorge','nath','ravi','andrew','maya','crystal','brandyn',
            'denise','ivana','kevin','tina','jens','ward','gary','mehul'].includes(firstRow[0].toLowerCase().split(' ')[0]);

        // Try to detect role table by checking if values look like role names
        const roleKeywords = ['product manager','program manager','engineering manager','engineering lead',
          'tech lead','design lead','design','content design','ux research','product owner'];
        const looksLikeRoleTable = roleKeywords.some(r => rows.some(row => row[0] && row[0].toLowerCase().includes(r)));

        if (looksLikeRoleTable && !foundMemberTable) {
          // Role assignment table
          for (const row of rows) {
            const role = (row[0] || '').toLowerCase();
            const name = row[1] || '';
            if (!name || name.toLowerCase() === 'name') continue;

            if (role.includes('product manager') && !role.includes('program')) team.pm = name;
            else if (role.includes('program manager'))  team.pgm = name;
            else if (role === 'engineering manager')     team.em = name;
            else if (role === 'engineering lead')        team.engLead = name;
            else if (role === 'tech lead')               team.techLead = name;
            else if (role.includes('design lead') || role === 'design') team.design = name;
            else if (role.includes('content design'))    team.content = name;
            else if (role.includes('ux research'))       team.ux = name;
          }
        } else {
          // Member table
          foundMemberTable = true;
          for (const row of rows) {
            const rawName = row[0] || '';
            const title   = row[1] || '';
            const moved   = row[1] || '';

            if (!rawName || rawName.toLowerCase() === 'name' || rawName.startsWith('---')) continue;

            // Skip headcount rows
            if (rawName.toLowerCase().includes('headcount')) continue;

            const isCtrct = rawName.toUpperCase().includes('CTRCT');
            const cleanName = rawName.replace(/^CTRCT\s*[-–]\s*/i, '').trim();

            if (!cleanName) continue;

            if (team.redistributing && moved && moved !== title) {
              team.members.push({ name: cleanName, title: '', ctrct: false, moved });
            } else {
              team.members.push({ name: cleanName, title, ctrct: isCtrct });
            }
          }
        }
      }
    }
  }

  return groups;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔄  Fetching Confluence page…');
  const page = await get(`/wiki/rest/api/content/${PAGE}?expand=body.export_view,version`);

  const html      = page.body.export_view.value;
  const updatedAt = page.version.when;
  const version   = page.version.number;

  console.log(`✅  Got page v${version}, updated ${updatedAt}`);

  const groups = parseHTML(html);
  const totalTeams   = groups.reduce((a,g) => a + g.teams.length, 0);
  const totalMembers = groups.reduce((a,g) => a + g.teams.reduce((b,t) => b + t.members.length, 0), 0);

  console.log(`📊  ${groups.length} groups | ${totalTeams} teams | ${totalMembers} members`);

  if (totalMembers === 0) {
    console.warn('⚠️  0 members — dumping HTML sample:');
    console.log(html.slice(0, 3000));
    process.exit(1);
  }

  // Build output — inject structured groups directly (no re-parsing needed)
  const tmpl = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const injection = `window.__PE_GROUPS__ = ${JSON.stringify(groups)};\nwindow.__PE_META__ = ${JSON.stringify({ updatedAt, version })};`;
  const out = tmpl.replace('/* __INJECT_DATA__ */', injection);

  fs.mkdirSync(path.join(__dirname, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'docs', 'index.html'), out);
  console.log('📄  Written to docs/index.html');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
