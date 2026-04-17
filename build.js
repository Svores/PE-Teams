// build.js — reads data.json and injects it into index.html
// The workflow fetches data.json from Confluence via curl
// Run: node build.js

const fs   = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, 'data.json');
if (!fs.existsSync(dataPath)) {
  console.error('❌  data.json not found. The workflow should have created it.');
  process.exit(1);
}

const raw  = fs.readFileSync(dataPath, 'utf8');
const data = JSON.parse(raw);

console.log(`✅  Loaded data.json (v${data.version}, updated ${data.updatedAt})`);

const totalMembers = (data.page.body.match(/\*\*Team Members \(FTE\):\*\*/g) || []).length;
console.log(`📊  Found ${totalMembers} team member sections`);

const tmpl = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const injection = `window.__CONFLUENCE_DATA__ = ${JSON.stringify(data)};`;
const out = tmpl.replace(
  'const CONFLUENCE_DATA = window.__CONFLUENCE_DATA__ || null;',
  injection + '\nconst CONFLUENCE_DATA = window.__CONFLUENCE_DATA__ || null;'
);

fs.mkdirSync(path.join(__dirname, 'docs'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'docs', 'index.html'), out);
console.log('📄  Written to docs/index.html');
