FROM node:20-slim

# Install LibreOffice and dependencies for PDF conversion
RUN apt-get update && apt-get install -y \
    libreoffice \
    libreoffice-writer \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

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
