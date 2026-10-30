FROM maven:3.8.5-openjdk-11-slim

# Install packages
# Debian bullseye is archived: point apt at archive.debian.org so the build works.
RUN sed -i 's|deb.debian.org|archive.debian.org|g; s|security.debian.org/debian-security|archive.debian.org/debian-security|g' /etc/apt/sources.list \
  && apt-get -o Acquire::Check-Valid-Until=false update \
  && apt-get install -y --no-install-recommends supervisor

# Setup app
RUN mkdir -p /app

# Copy flag
COPY flag.txt /flag.txt

# Add application
WORKDIR /app
COPY challenge .

# Setup superivsord
COPY config/supervisord.conf /etc/supervisord.conf

# Expose the port spring-app is reachable on
EXPOSE 1337

# Clean maven and install packages
RUN mvn clean package

# Copy entrypoint
COPY --chown=root entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]