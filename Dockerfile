# Production Dockerfile for 24/7 Cloud Hosting
FROM node:22-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --production

# Copy application source code
COPY . .

# Expose standard cloud port
EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "server.js"]
