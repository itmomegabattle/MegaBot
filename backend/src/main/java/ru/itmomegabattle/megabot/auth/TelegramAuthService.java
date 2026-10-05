package ru.itmomegabattle.megabot.auth;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;


@Service
class TelegramAuthService {

	private final TelegramIdentityService identities;
	private final SessionService sessions;

	TelegramAuthService(TelegramIdentityService identities, SessionService sessions) {
		this.identities = identities;
		this.sessions = sessions;
	}

	@Transactional
	LoginResult login(VerifiedTelegramUser telegramUser) {
		var user = identities.resolve(telegramUser)
				.orElseThrow(() -> new AuthenticationRejectedException("Пользователь не добавлен в команду или недоступен"));
		var session = sessions.rotateFor(user.getId());
		return new LoginResult(
				new AuthenticatedUser(user.getId(), user.getUsername(), user.getRealName(), user.getRole()),
				session);
	}

	record LoginResult(AuthenticatedUser user, SessionService.CreatedSession session) {
	}
}
