const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

async function main() {
  const imageDir = './images';
  if (!fs.existsSync(imageDir)) {
      console.log("No images directory found.");
      return;
  }
  const files = fs.readdirSync(imageDir).filter(f => /\.(png|jpg|jpeg)$/i.test(f));
  let totalBefore = 0;
  let totalAfter = 0;

  for (const file of files) {
    const input = path.join(imageDir, file);
    const output = path.join(imageDir, file.replace(/\.(png|jpg|jpeg)$/i, '.webp'));
    
    const beforeSize = fs.statSync(input).size;
    totalBefore += beforeSize;

    await sharp(input).webp({ quality: 80 }).toFile(output);
    
    const afterSize = fs.statSync(output).size;
    totalAfter += afterSize;

    console.log(`変換完了: ${file} (${(beforeSize/1024).toFixed(1)}KB) → ${path.basename(output)} (${(afterSize/1024).toFixed(1)}KB) - reduction: ${((1 - afterSize/beforeSize)*100).toFixed(1)}%`);
  }
  console.log(`\n=========== SUMMARY ===========`);
  console.log(`トータル削減: ${(totalBefore/1024).toFixed(1)}KB → ${(totalAfter/1024).toFixed(1)}KB (-${((1 - totalAfter/totalBefore)*100).toFixed(1)}%)`);
}

main().catch(console.error);
