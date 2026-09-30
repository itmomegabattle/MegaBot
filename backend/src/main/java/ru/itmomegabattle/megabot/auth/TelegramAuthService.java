package ru.itmomegabattle.megabot.auth;

import java.util.LinkedHashMap;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.itmomegabattle.megabot.team.UserEntity;
import ru.itmomegabattle.megabot.team.UserRepository;

@Service
class TelegramAuthService {

	private final UserRepository users;
	private final SessionService sessions;
	private final TelegramAuthProperties properties;

	TelegramAuthService(UserRepository users, SessionService sessions, TelegramAuthProperties properties) {
		this.users = users;
		this.sessions = sessions;
		this.properties = properties;
	}

	@Transactional
	LoginResult login(VerifiedTelegramUser telegramUser) {
		var user = users.findByTelegramId(telegramUser.id())
				.orElseGet(() -> bindOrBootstrap(telegramUser));
		if (!user.isActive()) {
			throw new AuthenticationRejectedException("Пользователь деактивирован");
		}
		if (properties.isBootstrapAdmin(telegramUser.id())) {
			user.grantAdminRole();
		}
		user.bindTelegramIdentity(telegramUser.id(), telegramUser.username());
		users.save(user);
		var session = sessions.rotateFor(user.getId());
		return new LoginResult(
				new AuthenticatedUser(user.getId(), user.getUsername(), user.getRealName(), user.getRole()),
				session);
	}

	private UserEntity bindOrBootstrap(VerifiedTelegramUser telegramUser) {
		var candidates = new LinkedHashMap<String, UserEntity>();
		if (telegramUser.username() != null) {
			users.findByUsernameIgnoreCaseAndTelegramIdIsNullAndActiveTrue(telegramUser.username())
					.forEach(user -> candidates.put(user.getId(), user));
			users.findByUsernameIgnoreCaseAndTelegramIdIsNullAndActiveTrue("@" + telegramUser.username())
					.forEach(user -> candidates.put(user.getId(), user));
		}
		if (candidates.size() > 1) {
			throw new AuthenticationRejectedException("Найдено несколько профилей с таким username");
		}
		if (candidates.size() == 1) {
			return candidates.values().iterator().next();
		}
		if (!properties.isBootstrapAdmin(telegramUser.id())) {
			throw new AuthenticationRejectedException("Пользователь не добавлен в команду");
		}
		var username = telegramUser.username() == null ? "telegram_" + telegramUser.id() : telegramUser.username();
		return users.save(new UserEntity(telegramUser.id(), username, telegramUser.displayName(), "admin"));
	}

	record LoginResult(AuthenticatedUser user, SessionService.CreatedSession session) {
	}
}
