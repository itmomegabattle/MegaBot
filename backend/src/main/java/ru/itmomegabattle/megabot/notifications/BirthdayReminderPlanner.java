package ru.itmomegabattle.megabot.notifications;

import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.common.SqlTime;
import tools.jackson.databind.ObjectMapper;

@Service
public class BirthdayReminderPlanner {
	private static final ZoneId MOSCOW=ZoneId.of("Europe/Moscow");
	private final JdbcClient jdbc; private final DeliveryQueue queue; private final ObjectMapper json;
	private final int hour,amount; private final String phone,bank;
	public BirthdayReminderPlanner(JdbcClient jdbc,DeliveryQueue queue,ObjectMapper json,
			@Value("${megabot.birthdays.hour:12}") int hour,
			@Value("${megabot.birthdays.payment-phone:89105408050}") String phone,
			@Value("${megabot.birthdays.payment-bank:Сбер}") String bank,
			@Value("${megabot.birthdays.max-amount:400}") int amount) {
		if(hour<0 || hour>23 || amount<1 || phone.isBlank() || phone.length()>100 || bank.isBlank() || bank.length()>100)
			throw new IllegalArgumentException("invalid_birthday_configuration");
		this.jdbc=jdbc;this.queue=queue;this.json=json;this.hour=hour;this.phone=phone;this.bank=bank;this.amount=amount;
	}
	@Transactional
	public int materialize() {
		var now=jdbc.sql("select clock_timestamp()").query((r,i)->r.getTimestamp(1).toInstant()).single();
		var today=now.atZone(MOSCOW).toLocalDate();var due=today.atTime(hour,0).atZone(MOSCOW).toInstant();
		if(now.isBefore(due))return 0;
		var expiry=today.plusDays(1).atStartOfDay(MOSCOW).toInstant();
		// ponytail: one bounded calendar day, no replay/backfill of old birthday offsets.
		var people=jdbc.sql("select id,telegram_id,real_name,birthday_day,birthday_month from users where active and registered and role in ('admin','organizer') order by id")
				.query((r,i)->new Person(r.getString(1),(Long)r.getObject(2),r.getString(3),r.getObject(4,Integer.class),r.getObject(5,Integer.class))).list();
		int count=0;
		for(var person:people)for(int before=0;before<=2;before++) {
			var birthday=today.plusDays(before);
			if(person.day()==null || person.month()==null || person.day()!=birthday.getDayOfMonth() || person.month()!=birthday.getMonthValue())continue;
			var occurrence="birthday_occ_"+UUID.randomUUID();
			var closes=birthday.atTime(19,0).atZone(MOSCOW).toInstant();
			int inserted=jdbc.sql("""
					insert into birthday_reminder_occurrences(id,birthday_user_id,birthday_date,days_before,intended_at,expires_at,collection_closes_at,state)
					values (:id,:user,:date,:before,:due,:expiry,:closes,'queued') on conflict (birthday_user_id,birthday_date,days_before) do nothing
					""").param("id",occurrence).param("user",person.id()).param("date",birthday).param("before",before).param("due",SqlTime.of(due)).param("expiry",SqlTime.of(expiry)).param("closes",SqlTime.of(closes)).update();
			if(inserted==0)continue;count++;
			var payload=json.writeValueAsString(Map.of("text",text(person.name(),birthday,before,false),"closedText",text(person.name(),birthday,before,true)));
			int queued=0,unavailable=0;
			for(var recipient:people) {
				if(recipient.id().equals(person.id()))continue;
				var target="birthday_target_"+UUID.randomUUID();boolean sendable=recipient.chat()!=null && recipient.chat()>0;
				jdbc.sql("insert into birthday_reminder_targets(id,occurrence_id,recipient_id,chat_id,state) values (:id,:occurrence,:user,:chat,:state)")
						.param("id",target).param("occurrence",occurrence).param("user",recipient.id()).param("chat",sendable?recipient.chat():null).param("state",sendable?"queued":"unavailable").update();
				if(!sendable) { unavailable++;continue; }
				var delivery=queue.enqueue(new DeliveryQueue.NewDelivery(occurrence,"birthday:"+person.id()+":"+birthday+":"+before+":"+recipient.id(),"birthday_reminder",recipient.id(),recipient.chat(),null,payload,false,due,due,expiry));
				jdbc.sql("update notification_deliveries set birthday_reminder_target_id=:target where id=:id").param("target",target).param("id",delivery).update();queued++;
			}
			jdbc.sql("update birthday_reminder_occurrences set state=:state,unavailable_count=:unavailable where id=:id")
					.param("state",queued==0?"unavailable":"queued").param("unavailable",unavailable).param("id",occurrence).update();
		}return count;
	}
	private String text(String name,LocalDate date,int before,boolean closed) {
		String when=switch(before) { case 2->"Через 2 дня";case 1->"Завтра";default->"Сегодня"; };
		var deadline=DateTimeFormatter.ofPattern("dd.MM.yyyy").format(date)+" в 19:00 (МСК)";
		var collection=closed?"🎁 Сбор на подарок завершён. Дедлайн был "+deadline+". После этого времени покупаем подарок, деньги больше не переводите.":
				"🎁 Сбор на подарок: переводите на "+bank+" по номеру "+phone+".\nДо "+amount+" ₽ с человека — это максимальная сумма, можно отправить меньше.\n⏰ Дедлайн: "+deadline+", в день рождения. После 19:00 сбор закрывается и покупаем подарок.";
		return "🎂 "+when+" день рождения у "+name+"!\n\nНе забудьте поздравить 🎉\n\n"+collection;
	}
	private record Person(String id,Long chat,String name,Integer day,Integer month) {}
}
