package ru.itmomegabattle.megabot;

import org.springframework.boot.SpringApplication;

public class TestMegaBotApplication {

	public static void main(String[] args) {
		SpringApplication.from(MegaBotApplication::main).with(TestcontainersConfiguration.class).run(args);
	}

}
