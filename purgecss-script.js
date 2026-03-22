const { PurgeCSS } = require('purgecss');
const fs = require('fs');

async function main() {
  const result = await new PurgeCSS().purge({
    content: [
      'index.html',
      'js/main.js',
    ],
    css: [
      'css/style.css',
      'css/dashboard-mockup.css'
    ],
    safelist: {
      standard: [/^hero/, /^btn/, /^nav/, /^mobile/, /^scroll/],
      deep: [/active$/, /open$/, /show$/, /hidden$/],
    }
  });

  result.forEach(r => {
    const originalSize = fs.statSync(r.file).size;
    const newSize = Buffer.byteLength(r.css, 'utf8');
    const reduction = ((originalSize - newSize) / originalSize * 100).toFixed(1);
    
    console.log(`\n📄 ${r.file}`);
    console.log(`オリジナルサイズ: ${(originalSize / 1024).toFixed(1)} KB`);
    console.log(`削減後サイズ: ${(newSize / 1024).toFixed(1)} KB`);
    console.log(`削減率: ${reduction}%`);

    if (reduction >= 50) {
      fs.writeFileSync(r.file, r.css);
      console.log(`✅ 50%以上の削減に成功したため、${r.file} を上書き保存しました。`);
    } else {
      console.log(`⚠️ 削減率が50%未満(${reduction}%)のため、上書きをスキップしました。`);
    }
  });
}

main().catch(console.error);
