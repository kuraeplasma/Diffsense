FROM node:20-slim

# Install LibreOffice and dependencies for PDF conversion
RUN apt-get update && apt-get install -y \
    libreoffice \
    libreoffice-writer \
    libreoffice-java-common \
    default-jre \
    curl \
    fontconfig \
    fonts-noto-cjk \
    fonts-noto-cjk-extra \
    fonts-ipaexfont \
    fonts-ipafont \
    poppler-utils \
    locales \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set locale for Japanese font rendering stability
RUN locale-gen ja_JP.UTF-8
ENV LANG=ja_JP.UTF-8
ENV LC_ALL=ja_JP.UTF-8

# Configure fontconfig to map Windows fonts to Linux equivalents
RUN mkdir -p /etc/fonts/local.d
RUN echo '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>\
  <match target="pattern"><test name="family"><string>Yu Gothic</string></test><edit name="family" mode="assign" binding="strong"><string>Noto Sans CJK JP</string></edit></match>\
  <match target="pattern"><test name="family"><string>Yu Gothic UI</string></test><edit name="family" mode="assign" binding="strong"><string>Noto Sans CJK JP</string></edit></match>\
  <match target="pattern"><test name="family"><string>Yu Mincho</string></test><edit name="family" mode="assign" binding="strong"><string>Noto Serif CJK JP</string></edit></match>\
  <match target="pattern"><test name="family"><string>MS Gothic</string></test><edit name="family" mode="assign" binding="strong"><string>IPAexGothic</string></edit></match>\
  <match target="pattern"><test name="family"><string>ＭＳ ゴシック</string></test><edit name="family" mode="assign" binding="strong"><string>IPAexGothic</string></edit></match>\
  <match target="pattern"><test name="family"><string>MS Mincho</string></test><edit name="family" mode="assign" binding="strong"><string>IPAexMincho</string></edit></match>\
  <match target="pattern"><test name="family"><string>ＭＳ 明朝</string></test><edit name="family" mode="assign" binding="strong"><string>IPAexMincho</string></edit></match>\
  <match target="pattern"><test name="family"><string>Meiryo</string></test><edit name="family" mode="assign" binding="strong"><string>Noto Sans CJK JP</string></edit></match>\
  <match target="pattern"><test name="family"><string>メイリオ</string></test><edit name="family" mode="assign" binding="strong"><string>Noto Sans CJK JP</string></edit></match>\
</fontconfig>' > /etc/fonts/local.conf

# Refresh font cache
RUN fc-cache -fv

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm install --production

# Copy the rest of the application
COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080

# Cloud Run uses the PORT environment variable
EXPOSE 8080

# Start the server
CMD ["node", "src/server.js"]
