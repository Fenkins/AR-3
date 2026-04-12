FROM node:22-slim

WORKDIR /app

# Install Python for FAISS
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install FAISS
RUN pip3 install faiss-cpu numpy

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build application
RUN npm run build

# Expose port
EXPOSE 3000

# Create volumes for persistence
VOLUME ["/app/knowledge-base", "/app/sandboxes", "/app/prisma"]

# Start application
CMD ["npm", "start"]
