package ru.itmomegabattle.megabot.auth;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpMethod;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.AnonymousAuthenticationFilter;
import org.springframework.security.web.authentication.HttpStatusEntryPoint;
import org.springframework.security.web.access.intercept.AuthorizationFilter;

@Configuration(proxyBeanMethods = false)
@EnableMethodSecurity
class SecurityConfiguration {
	@Bean
	@Order(1)
	SecurityFilterChain telegramWebhookChain(HttpSecurity http) throws Exception {
		// Exact machine endpoint: cookie/session and browser Origin are not webhook authentication.
		return http.securityMatcher("/api/v1/telegram/webhook")
				.csrf(AbstractHttpConfigurer::disable).formLogin(AbstractHttpConfigurer::disable)
				.httpBasic(AbstractHttpConfigurer::disable).logout(AbstractHttpConfigurer::disable)
				.requestCache(cache->cache.disable())
				.sessionManagement(session->session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
				.authorizeHttpRequests(access->access.requestMatchers(HttpMethod.POST,"/api/v1/telegram/webhook").permitAll().anyRequest().denyAll())
				.build();
	}

	@Bean
	SecurityFilterChain securityFilterChain(
			HttpSecurity http,
			SessionService sessions,
			WebSecurityProperties securityProperties) throws Exception {
		var sessionFilter = new SessionAuthenticationFilter(sessions);
		var originFilter = new OriginProtectionFilter(securityProperties);

		http
				.csrf(AbstractHttpConfigurer::disable)
				.cors(Customizer.withDefaults())
				.formLogin(AbstractHttpConfigurer::disable)
				.httpBasic(AbstractHttpConfigurer::disable)
				.logout(AbstractHttpConfigurer::disable)
				.requestCache(cache -> cache.disable())
				.sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
				.exceptionHandling(errors -> errors.authenticationEntryPoint(new HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED)))
				.authorizeHttpRequests(authorize -> authorize
						.requestMatchers("/actuator/health/**", "/api/v1/auth/telegram").permitAll()
						.anyRequest().authenticated())
				.addFilterBefore(sessionFilter, AnonymousAuthenticationFilter.class)
				.addFilterBefore(originFilter, AuthorizationFilter.class);
		return http.build();
	}
}
