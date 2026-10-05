package ru.itmomegabattle.megabot.auth;

import java.util.LinkedHashMap;
import java.util.Optional;
import jakarta.persistence.EntityManager;
import jakarta.persistence.LockModeType;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.team.UserEntity;
import ru.itmomegabattle.megabot.team.UserRepository;

/** Internal: identity must already be verified by Mini App HMAC or authenticated Telegram intake. */
@Service
public class TelegramIdentityService {
	private final UserRepository users;
	private final TelegramAuthProperties properties;
	private final EntityManager entities;
	TelegramIdentityService(UserRepository users,TelegramAuthProperties properties,EntityManager entities) {
		this.users=users;this.properties=properties;this.entities=entities;
	}
	@Transactional(propagation=Propagation.MANDATORY)
	public Optional<UserEntity> resolve(VerifiedTelegramUser identity) {
		if(identity==null || identity.id()<=0) throw new IllegalArgumentException("Invalid verified identity");
		var found=users.findByTelegramId(identity.id());
		if(found.isEmpty()) {
			var candidates=new LinkedHashMap<String,UserEntity>();
			if(identity.username()!=null) {
				users.findByUsernameIgnoreCaseAndTelegramIdIsNullAndActiveTrue(identity.username()).forEach(u->candidates.put(u.getId(),u));
				users.findByUsernameIgnoreCaseAndTelegramIdIsNullAndActiveTrue("@"+identity.username()).forEach(u->candidates.put(u.getId(),u));
			}
			if(candidates.size()>1) return Optional.empty();
			if(candidates.size()==1) found=Optional.of(candidates.values().iterator().next());
			else if(properties.isBootstrapAdmin(identity.id())) {
				var username=identity.username()==null?"telegram_"+identity.id():identity.username();
				found=Optional.of(new UserEntity(identity.id(),username,identity.displayName(),"admin"));
			}
		}
		if(found.isEmpty()) return Optional.empty();
		var user=found.get();
		// Re-read under a row lock: a concurrent login/binding/deactivation must not authorize stale state.
		if(user.getId()!=null) entities.refresh(user,LockModeType.PESSIMISTIC_WRITE);
		if(!user.isActive() || user.getTelegramId()!=null && user.getTelegramId()!=identity.id()) return Optional.empty();
		if(user.getTelegramId()==null && (identity.username()==null ||
				!user.getUsername().equalsIgnoreCase(identity.username()) && !user.getUsername().equalsIgnoreCase("@"+identity.username())))
			return Optional.empty();
		if(properties.isBootstrapAdmin(identity.id())) user.grantAdminRole();
		user.bindTelegramIdentity(identity.id(),identity.username());
		return Optional.of(users.saveAndFlush(user));
	}
}
