package ru.itmomegabattle.megabot.team;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.Version;

@Entity
@Table(name = "users")
public class UserEntity {

	@Id
	private String id;

	@Column(name = "telegram_id", unique = true)
	private Long telegramId;

	@Column(nullable = false)
	private String username;

	@Column(name = "real_name", nullable = false)
	private String realName;

	@Column(nullable = false)
	private String role;

	@Column(nullable = false)
	private boolean registered;

	@Column(nullable = false)
	private boolean active = true;

	@Column(name = "birthday_day")
	private Integer birthdayDay;

	@Column(name = "birthday_month")
	private Integer birthdayMonth;

	@Column(name = "birthday_year")
	private Integer birthdayYear;

	@Column(name = "deactivated_at")
	private Instant deactivatedAt;

	@Column(name = "deactivated_by")
	private String deactivatedBy;

	@Version
	@Column(nullable = false)
	private long version;

	@Column(name = "created_at", nullable = false, updatable = false)
	private Instant createdAt;

	@Column(name = "updated_at", nullable = false)
	private Instant updatedAt;

	protected UserEntity() {
	}

	public UserEntity(Long telegramId, String username, String realName, String role) {
		this.telegramId = telegramId;
		this.username = username;
		this.realName = realName;
		this.role = role;
		this.registered = telegramId != null;
	}

	@PrePersist
	void initialize() {
		if (id == null) {
			id = "u_" + UUID.randomUUID();
		}
		var now = Instant.now();
		if (createdAt == null) {
			createdAt = now;
		}
		updatedAt = now;
	}

	@PreUpdate
	void touch() {
		updatedAt = Instant.now();
	}

	public String getId() {
		return id;
	}

	public Long getTelegramId() {
		return telegramId;
	}

	public String getUsername() {
		return username;
	}

	public String getRealName() {
		return realName;
	}

	public String getRole() {
		return role;
	}

	public boolean isRegistered() {
		return registered;
	}

	public boolean isActive() {
		return active;
	}

	public long getVersion() {
		return version;
	}

	public Integer getBirthdayDay() {
		return birthdayDay;
	}

	public Integer getBirthdayMonth() {
		return birthdayMonth;
	}

	public Integer getBirthdayYear() {
		return birthdayYear;
	}

	public Instant getDeactivatedAt() {
		return deactivatedAt;
	}

	public void rename(String realName) {
		this.realName = realName;
	}

	public void updateProfile(String realName, String username, Integer birthdayDay, Integer birthdayMonth, Integer birthdayYear) {
		this.realName = realName;
		this.username = username;
		this.birthdayDay = birthdayDay;
		this.birthdayMonth = birthdayMonth;
		this.birthdayYear = birthdayYear;
	}

	public void changeRole(String role) {
		this.role = role;
	}

	public void deactivate(String actorId, Instant now) {
		this.active = false;
		this.deactivatedBy = actorId;
		this.deactivatedAt = now;
	}

	public void reactivate() {
		this.active = true;
		this.deactivatedBy = null;
		this.deactivatedAt = null;
	}

	public void bindTelegramIdentity(long telegramId, String username) {
		if (this.telegramId != null && this.telegramId != telegramId) {
			throw new IllegalStateException("Telegram identity is already bound");
		}
		this.telegramId = telegramId;
		if (username != null && !username.isBlank()) {
			this.username = username;
		}
		this.registered = true;
	}

	public void grantAdminRole() {
		this.role = "admin";
	}
}
