plugins {
    kotlin("jvm") version "1.9.0"
    id("org.springframework.boot") version "3.0.0"
    `java-library`
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.0")
    api("com.google.guava:guava:32.1.2-jre")
    api(project(":core"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.0")
    testImplementation(libs.mockito.core)
}
