FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY fafo-drive-proxy.js ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "fafo-drive-proxy.js"]
