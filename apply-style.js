const { PurgeCSS } = require('purgecss');
const fs = require('fs');

async function main() {
  const result = await new PurgeCSS().purge({
    content: [
      'index.html',
      'js/main.js',
    ],
    css: [
      'css/style.css.bak'
    ],
    safelist: {
      standard: [/^hero/, /^btn/, /^nav/, /^mobile/, /^scroll/],
      deep: [/active$/, /open$/, /show$/, /hidden$/],
    }
  });

  const parsed = result[0];
  fs.writeFileSync('css/style.css', parsed.css);
  console.log(`✅ css/style.css に削減版（${parsed.css.length} bytes）を強制適用しました！`);
}

main().catch(console.error);
