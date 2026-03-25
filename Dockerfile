FROM node:18-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN node setup-db.js
EXPOSE 3000
CMD ["node", "server.js"]
