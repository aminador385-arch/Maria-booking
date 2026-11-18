# ═══ ماريا — صورة إنتاج ═══
FROM node:22-alpine AS base
ENV NODE_ENV=production
WORKDIR /app

# 1) التبعيات (طبقة منفصلة للاستفادة من الكاش)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 2) الكود
COPY src ./src
COPY public ./public

# 3) مستخدم غير جذري + مجلد بيانات محلي (يُستبدل بـ Postgres في الإنتاج)
RUN addgroup -S maria && adduser -S maria -G maria \
 && mkdir -p /app/data && chown -R maria:maria /app
USER maria

EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
