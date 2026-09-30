# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---------- test (CI: docker build --target test .) ----------
FROM build AS test
RUN npm run test:client

# ---------- php-fpm ----------
FROM php:8.5-fpm-alpine AS php
WORKDIR /app
RUN addgroup -S -g 10001 rc && adduser -S -D -H -u 10001 -G rc rc \
    && mkdir -p /app/api/var && chown -R rc:rc /app/api/var && chmod 700 /app/api/var
COPY docker/php/php-fpm.conf /usr/local/etc/php-fpm.d/zz-app.conf
COPY docker/php/php.ini /usr/local/etc/php/conf.d/zz-app.ini
COPY api ./api
USER rc
ENV DATABASE_PATH=/app/api/var/sync.sqlite
EXPOSE 9000

# ---------- nginx ----------
FROM nginxinc/nginx-unprivileged:stable-alpine AS web
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
# The whole `app` directory is the docroot, sources included, and the sources
# stay unreachable because docker/nginx/default.conf refuses /js/ and /css/ —
# the shell loads nothing from them. Copying the directory rather than a curated
# list of the running files is what lets `docker-compose.override.yml` mount the
# working tree over this path in development and see the same layout.
#
# `npm run build` above has already written app/dist: the content-hashed assets
# and the built shell at app/dist/index.html, which is what `/` resolves to.
COPY --from=build /app/app /usr/share/nginx/html
# The config itself is NOT parsed at build time: `fastcgi_pass php:9000` makes
# nginx resolve a name that only exists on the compose network, so `nginx -t`
# here fails with `host not found in upstream "php"` and can never pass. The real
# check runs where the name resolves — `docker compose run --rm --entrypoint
# nginx web -t`, with the php service attached — and it is not optional and it
# is not covered by any test: an unquoted `{8}` quantifier in a `location ~` is a
# syntax error to nginx and an ordinary string to a test that reads the file, and
# docker-router.php implements the same cache policy in PHP, so it never
# exercises nginx's parser.
EXPOSE 8080
