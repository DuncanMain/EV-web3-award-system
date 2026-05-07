# Node.js Docker image for NVF Award Core
FROM node:20-alpine AS build

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY tsconfig.json .
COPY src ./src
COPY .env.example ./

RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY --from=build /usr/src/app/dist ./dist
COPY .env.example ./

EXPOSE 3000

CMD ["node", "dist/api.js"]
