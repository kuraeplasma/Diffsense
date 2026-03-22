const fs = require('fs');

const htmlFile = 'index.html';
let html = fs.readFileSync(htmlFile, 'utf8');

const regex = /<img\s+([^>]*?)src=["'](images\/[^"']+\.(png|jpg|jpeg)(?:\?.*?)?)["']([^>]*)>/gi;

let count = 0;
html = html.replace(regex, (match, prefix, srcWithQuery, ext, suffix) => {
    // Check if it's already wrapped in a <picture> tag by simply looking at the file context. 
    // Since we're doing global replace, we assume they aren't wrapped yet.
    
    // Strip query string for extension replacement, then append it back if needed, 
    // but usually webp doesn't need the query string for cache busting unless requested, 
    // we'll just replace the extension.
    const src = srcWithQuery.split('?')[0];
    const query = srcWithQuery.split('?')[1] ? '?' + srcWithQuery.split('?')[1] : '';
    
    const webpSrc = src.replace(/\.(png|jpg|jpeg)$/i, '.webp') + query;
    const imgTag = `<img ${prefix}src="${srcWithQuery}"${suffix}>`;
    
    count++;
    return `<picture>
  <source srcset="${webpSrc}" type="image/webp">
  ${imgTag}
</picture>`;
});

fs.writeFileSync(htmlFile, html);
console.log(`Updated ${count} img tags.`);
