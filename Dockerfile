FROM node:20-alpine

RUN apk add --no-cache dumb-init

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
