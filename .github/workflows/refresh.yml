name: Refresh PE Teams Page

on:
  schedule:
    - cron: '0 */2 * * *'
  workflow_dispatch:

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - name: Checkout repo
        uses: actions/checkout@v4

      - name: Fetch Confluence page (markdown format)
        env:
          CONFLUENCE_EMAIL: ${{ secrets.CONFLUENCE_EMAIL }}
          CONFLUENCE_TOKEN: ${{ secrets.CONFLUENCE_TOKEN }}
        run: |
          # Fetch the page using the Confluence REST API with markdown body format
          curl -s \
            -u "$CONFLUENCE_EMAIL:$CONFLUENCE_TOKEN" \
            -H "Accept: application/json" \
            "https://thryv.atlassian.net/wiki/api/v2/pages/4281368617?body-format=atlas_doc_format" \
            -o raw_page.json

          # Extract version and timestamp using node
          node -e "
            const raw = JSON.parse(require('fs').readFileSync('raw_page.json','utf8'));
            console.log('Page version:', raw.version?.number || 'unknown');
            console.log('Status:', raw.status || 'unknown');
          "

          # Now fetch with markdown body format (different endpoint)
          curl -s \
            -u "$CONFLUENCE_EMAIL:$CONFLUENCE_TOKEN" \
            -H "Accept: application/json" \
            "https://thryv.atlassian.net/wiki/rest/api/content/4281368617?expand=body.export_view,version" \
            -o page_export.json

          # Build data.json using node
          node -e "
            const fs = require('fs');
            const page = JSON.parse(fs.readFileSync('page_export.json','utf8'));
            
            if (!page.body) {
              console.error('No body found in response');
              console.error(JSON.stringify(page).slice(0,500));
              process.exit(1);
            }

            // Convert export_view HTML to markdown-like text
            let html = page.body.export_view.value;

            // Headings
            html = html.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => '\n## ' + t.replace(/<[^>]+>/g,'').trim() + '\n');
            html = html.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => '\n### ' + t.replace(/<[^>]+>/g,'').trim() + '\n');
            html = html.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, (_, t) => '**' + t.replace(/<[^>]+>/g,'').trim() + '**');

            // Info panels = redistribution notice
            html = html.replace(/<div[^>]*class=\"[^\"]*information-macro[^\"]*\"[^>]*>[\s\S]*?<\/div>/gi,
              '\n_**This team is being re-distributed**_\n');

            // Tables
            html = html.replace(/<table[\s\S]*?<\/table>/gi, tableHtml => {
              const rows = [];
              const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
              let trM;
              while ((trM = trRe.exec(tableHtml)) !== null) {
                const cells = [];
                const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
                let tdM;
                while ((tdM = tdRe.exec(trM[1])) !== null) {
                  cells.push(tdM[1].replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,\"'\").trim());
                }
                if (cells.length) rows.push('| ' + cells.join(' | ') + ' |');
              }
              return '\n' + rows.join('\n') + '\n';
            });

            // Team member headers
            html = html.replace(/<p[^>]*><strong>Team Members \(FTE\):<\/strong><\/p>/gi, '\n**Team Members (FTE):**\n');
            html = html.replace(/<p[^>]*><strong>Contractors:<\/strong><\/p>/gi, '\n**Contractors:**\n');

            // Strip remaining tags
            html = html.replace(/<[^>]+>/g, ' ')
                       .replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,\"'\").replace(/&quot;/g,'\"')
                       .replace(/ {2,}/g,' ').replace(/\n{3,}/g,'\n\n').trim();

            const output = {
              page: { body: html },
              updatedAt: page.version.when,
              version: page.version.number
            };

            fs.writeFileSync('data.json', JSON.stringify(output));
            console.log('✅ data.json written, version', page.version.number);

            // Sanity check
            const memberSections = (html.match(/\*\*Team Members/g) || []).length;
            console.log('📊 Team member sections found:', memberSections);
            if (memberSections === 0) {
              console.log('⚠️  Sample of converted text:');
              console.log(html.slice(0, 1000));
            }
          "

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Build HTML
        run: node build.js

      - name: Deploy to GitHub Pages
        uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./docs
