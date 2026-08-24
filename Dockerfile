FROM node:20-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Create data directory for SQLite persistence
RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "server.js"]
