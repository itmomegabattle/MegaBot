package ru.itmomegabattle.megabot.telegram;

import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.time.temporal.TemporalAdjusters;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import ru.itmomegabattle.megabot.team.UserEntity;

/** Private, own-user summary; invitation rows are the server's authoritative meeting audience. */
@Service
class TelegramProfileText {
	private static final ZoneId MOSCOW=ZoneId.of("Europe/Moscow");
	private final JdbcClient jdbc;
	TelegramProfileText(JdbcClient jdbc) { this.jdbc=jdbc; }
	String render(UserEntity user) {
		var now=jdbc.sql("select clock_timestamp()").query((r,i)->r.getTimestamp(1).toInstant()).single();
		var today=now.atZone(MOSCOW).toLocalDate();
		var week=today.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY));
		var tasks=jdbc.sql("""
				select count(*) filter(where t.status not in ('completed','cancelled')),
				count(*) filter(where t.status='completed')
				from tasks t join task_assignees a on a.task_id=t.id where a.user_id=:id
				""").param("id",user.getId()).query((r,i)->new long[]{r.getLong(1),r.getLong(2)}).single();
		var meetings=jdbc.sql("""
				select m.title,m.starts_at,count(*) over() as total from meetings m
				join meeting_invitations i on i.meeting_id=m.id and i.user_id=:id
				where m.status='scheduled' and m.starts_at+m.duration_minutes*interval '1 minute'>:now
				order by m.starts_at,m.id limit 1
				""").param("id",user.getId()).param("now",ru.itmomegabattle.megabot.common.SqlTime.of(now))
				.query((r,i)->new NextMeeting(r.getString(1),r.getTimestamp(2).toInstant().atZone(MOSCOW)
						.format(DateTimeFormatter.ofPattern("dd.MM.yyyy, HH:mm")),r.getLong(3))).optional();
		var hours=jdbc.sql("""
				select count(*) from availability_weeks w join availability_days d on d.week_id=w.id
				join availability_slots s on s.day_id=d.id
				where w.user_id=:id and w.week_start=:week and not w.out_of_week and d.status='available'
				""").param("id",user.getId()).param("week",week).query(Long.class).single();
		var primary=jdbc.sql("""
				select c.name from user_competencies uc join competencies c on c.id=uc.competency_id
				where uc.user_id=:id and uc.is_primary
				""").param("id",user.getId()).query(String.class).optional().orElse("не выбран");
		var role=switch(user.getRole()) { case "admin"->"администратор";case "organizer"->"организатор";
			case "faculty_responsible"->"ответственный факультета";default->"помощник факультета"; };
		String birthday="не указана",countdown="";
		if(user.getBirthdayDay()!=null) {
			birthday=String.format("%02d.%02d",user.getBirthdayDay(),user.getBirthdayMonth());
			if(user.getBirthdayYear()!=null)birthday+="."+user.getBirthdayYear()+" · "+(today.getYear()-user.getBirthdayYear())+" лет";
			// Legacy treats February 29 as March 1 in a non-leap year, not February 28.
			var next=birthdayInYear(user,today.getYear());
			if(next.isBefore(today))next=birthdayInYear(user,today.getYear()+1);
			long days=ChronoUnit.DAYS.between(today,next);
			countdown="\nДо дня рождения: "+(days==0?"сегодня":days+" дн.");
		}
		return bounded(user.getRealName(),100)+"\n"+(user.getUsername().startsWith("@")?"":"@")+bounded(user.getUsername(),64)+" · "+role
				+"\n\nГлавный блок: "+bounded(primary,200)+"\nДата рождения: "+birthday+countdown
				+"\n\nСейчас:\n• активных задач — "+tasks[0]+"\n• выполнено задач — "+tasks[1]
				+"\n• ближайших встреч — "+meetings.map(NextMeeting::total).orElse(0L)
				+"\n• свободных часов отмечено — "+hours
				+meetings.map(m->"\n\nСледующая встреча: "+m.date()+" — "+bounded(m.title(),300)).orElse("");
	}
	private static LocalDate birthdayInYear(UserEntity user,int year) {
		return LocalDate.of(year,user.getBirthdayMonth(),1).plusDays(user.getBirthdayDay()-1);
	}
	private static String bounded(String text,int max) { return text.length()>max?text.substring(0,max)+"…":text; }
	private record NextMeeting(String title,String date,long total) {}
}
