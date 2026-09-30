package ru.itmomegabattle.megabot;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class MegaBotApplication {

	public static void main(String[] args) {
		SpringApplication.run(MegaBotApplication.class, args);
	}

}
