"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectProject = detectProject;
exports.generateDockerfile = generateDockerfile;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
function detectProject(buildPath) {
    const has = (f) => fs_1.default.existsSync(path_1.default.join(buildPath, f));
    if (has('pnpm-lock.yaml') || has('.pnpmfile.cjs'))
        return 'node-pnpm';
    if (has('yarn.lock'))
        return 'node-yarn';
    if (has('bun.lockb'))
        return 'node-bun';
    if (has('package.json'))
        return 'node-npm';
    if (has('pyproject.toml'))
        return 'python-poetry';
    if (has('requirements.txt'))
        return 'python-pip';
    if (has('pom.xml'))
        return 'java-maven';
    if (has('build.gradle') || has('build.gradle.kts'))
        return 'java-gradle';
    if (has('go.mod'))
        return 'go';
    if (has('Gemfile'))
        return 'ruby';
    return 'unknown';
}
function generateDockerfile(type, port) {
    switch (type) {
        case 'node-npm':
            return `FROM node:22-slim
RUN apt-get update && apt-get install -y curl openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build --if-present
EXPOSE ${port}
CMD ["npm", "start"]`;
        case 'node-pnpm':
            return `FROM node:22-slim
RUN apt-get update && apt-get install -y curl openssl ca-certificates && rm -rf /var/lib/apt/lists/* && npm install -g pnpm
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run build
EXPOSE ${port}
CMD ["pnpm", "start"]`;
        case 'node-yarn':
            return `FROM node:22-slim
RUN apt-get update && apt-get install -y curl openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN yarn install --frozen-lockfile
RUN yarn build --if-present
EXPOSE ${port}
CMD ["yarn", "start"]`;
        case 'node-bun':
            return `FROM oven/bun:latest
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build --if-present
EXPOSE ${port}
CMD ["bun", "start"]`;
        case 'python-pip':
            return `FROM python:3.12-slim
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE ${port}
CMD ["python", "main.py"]`;
        case 'python-poetry':
            return `FROM python:3.12-slim
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
RUN pip install poetry
WORKDIR /app
COPY pyproject.toml poetry.lock* ./
RUN poetry install --no-root --no-dev
COPY . .
EXPOSE ${port}
CMD ["poetry", "run", "python", "main.py"]`;
        case 'java-maven':
            return `FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml ./
COPY src ./src
RUN mvn package -DskipTests
FROM eclipse-temurin:21-jre-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
EXPOSE ${port}
CMD ["java", "-jar", "app.jar"]`;
        case 'java-gradle':
            return `FROM gradle:8-jdk21 AS build
WORKDIR /app
COPY . .
RUN gradle build -x test
FROM eclipse-temurin:21-jre-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY --from=build /app/build/libs/*.jar app.jar
EXPOSE ${port}
CMD ["java", "-jar", "app.jar"]`;
        case 'go':
            return `FROM golang:1.22-alpine AS build
RUN apk add --no-cache curl
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o server .
FROM alpine:latest
RUN apk add --no-cache curl ca-certificates
WORKDIR /app
COPY --from=build /app/server .
EXPOSE ${port}
CMD ["./server"]`;
        case 'ruby':
            return `FROM ruby:3.3-alpine
RUN apk add --no-cache curl build-base
WORKDIR /app
COPY Gemfile Gemfile.lock ./
RUN bundle install
COPY . .
EXPOSE ${port}
CMD ["ruby", "app.rb"]`;
        default:
            throw new Error('Could not detect project type. ' +
                'Supported: Node (npm/pnpm/yarn/bun), Python (pip/poetry), ' +
                'Java (Maven/Gradle), Go, Ruby.');
    }
}
