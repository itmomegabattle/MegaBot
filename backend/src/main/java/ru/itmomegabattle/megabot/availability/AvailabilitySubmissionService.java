package ru.itmomegabattle.megabot.availability;

import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.common.ApiException;

/** Shared dated completeness rule for missing-slots notifications. */
@Service
public class AvailabilitySubmissionService {
	private final AvailabilitySettingsService settings;
	private final JdbcClient jdbc;
	private final Clock clock;
	AvailabilitySubmissionService(AvailabilitySettingsService settings,JdbcClient jdbc,Clock clock) { this.settings=settings;this.jdbc=jdbc;this.clock=clock; }
	@Transactional(readOnly=true)
	public void validateWeek(LocalDate week) {
		var today=LocalDate.now(clock.withZone(ZoneId.of("Europe/Moscow")));
		var monday=today.minusDays(today.getDayOfWeek().getValue()-1);
		if(week==null || week.getDayOfWeek().getValue()!=1 || week.isBefore(monday) || !week.isBefore(monday.plusWeeks(settings.get().weekCount())))
			throw new ApiException(HttpStatus.BAD_REQUEST,"invalid_broadcast_week","Выберите доступную неделю начиная с понедельника");
	}
	@Transactional(readOnly=true)
	public boolean submitted(String userId,LocalDate week) {
		var days=settings.get().activeDays();
		return jdbc.sql("""
				select count(*) from availability_weeks w where w.user_id=:user and w.week_start=:week and
				(w.out_of_week or (select count(*) from availability_days d where d.week_id=w.id
				and extract(isodow from d.day_date)-1 in (:days) and
				(d.status='unavailable' or exists(select 1 from availability_slots s where s.day_id=d.id)))=:count)
				""").param("user",userId).param("week",week).param("days",days).param("count",days.size()).query(Long.class).single()>0;
	}
}
