FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production --no-audit
COPY . .
CMD ["node", "bot.js"]
