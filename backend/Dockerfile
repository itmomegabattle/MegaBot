FROM maven:3.9.16-eclipse-temurin-21 AS build
WORKDIR /workspace
COPY pom.xml mvnw mvnw.cmd ./
COPY .mvn .mvn
RUN ./mvnw -B -DskipTests dependency:go-offline
COPY src src
RUN ./mvnw -B -DskipTests package

FROM eclipse-temurin:21-jre
RUN useradd --system --uid 10001 --create-home megabot
WORKDIR /app
COPY --from=build /workspace/target/megabot-0.0.1-SNAPSHOT.jar /app/megabot.jar
USER 10001
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/megabot.jar"]
