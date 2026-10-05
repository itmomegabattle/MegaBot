package ru.itmomegabattle.megabot.notifications;

import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.annotation.Propagation;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.common.*;

@Service
class BroadcastGroupTargets {
	private final JdbcClient jdbc; private final AuditWriter audit;
	BroadcastGroupTargets(JdbcClient jdbc,AuditWriter audit) { this.jdbc=jdbc;this.audit=audit; }
	@Transactional(readOnly=true)
	public Map<String,Object> list(boolean admin,int limit,String cursor) {
		if(limit<1 || limit>100)throw bad("invalid_limit");
		var rows=jdbc.sql("select * from broadcast_group_targets where (:admin or active) and id>:cursor order by id limit :limit")
				.param("admin",admin).param("cursor",cursor==null?"":cursor).param("limit",limit+1).query((r,i)->{
			var row=new LinkedHashMap<String,Object>();row.put("id",r.getString("id"));row.put("label",r.getString("label"));
			if(admin) { row.put("botId",r.getString("bot_id"));row.put("chatId",r.getLong("chat_id"));row.put("messageThreadId",r.getObject("message_thread_id"));row.put("active",r.getBoolean("active"));row.put("version",r.getLong("version")); }
			return (Map<String,Object>)row;
		}).list();
		var more=rows.size()>limit;var items=more?rows.subList(0,limit):rows;
		var result=new LinkedHashMap<String,Object>();result.put("items",items);result.put("nextCursor",more?items.getLast().get("id"):null);return result;
	}
	@Transactional
	public Map<String,Object> save(String id,BroadcastGroupTargetsController.Mutation r,AuthenticatedUser actor) {
		if(!"admin".equals(actor.role()))throw new ApiException(HttpStatus.FORBIDDEN,"admin_required","Только администратор разрешает групповые рассылки");
		boolean create=id==null;
		if(create)id="group_"+UUID.randomUUID();
		else {
			var version=jdbc.sql("select version from broadcast_group_targets where id=:id for update").param("id",id).query(Long.class).optional()
					.orElseThrow(()->new ApiException(HttpStatus.NOT_FOUND,"group_target_not_found","Адресат не найден"));
			if(r.expectedVersion()==null || !version.equals(r.expectedVersion()))throw new ApiException(HttpStatus.CONFLICT,"stale_version","Разрешение изменилось, обновите список");
		}
		if(create)jdbc.sql("insert into broadcast_group_targets(id,label,bot_id,chat_id,message_thread_id,active,approved_by) values (:id,:label,:bot,:chat,:thread,:active,:actor)")
				.param("id",id).param("label",r.label().strip()).param("bot",r.botId()).param("chat",r.chatId()).param("thread",r.messageThreadId()).param("active",r.active()).param("actor",actor.id()).update();
		else jdbc.sql("update broadcast_group_targets set label=:label,bot_id=:bot,chat_id=:chat,message_thread_id=:thread,active=:active,approved_by=:actor,version=version+1,updated_at=clock_timestamp() where id=:id")
				.param("id",id).param("label",r.label().strip()).param("bot",r.botId()).param("chat",r.chatId()).param("thread",r.messageThreadId()).param("active",r.active()).param("actor",actor.id()).update();
		audit.write(actor.id(),"broadcast_group_target",id,create?"created":"updated",Map.of("active",r.active()));
		return Map.of("id",id,"version",jdbc.sql("select version from broadcast_group_targets where id=:id").param("id",id).query(Long.class).single());
	}
	@Transactional(propagation=Propagation.MANDATORY)
	public List<Target> snapshot(List<String> ids) {
		if(ids==null || ids.isEmpty())throw bad("empty_broadcast_audience");
		var result=new ArrayList<Target>();
		for(var id:ids.stream().distinct().sorted().toList())result.add(jdbc.sql("select * from broadcast_group_targets where id=:id and active for share")
				.param("id",id).query((r,i)->new Target(id,r.getString("bot_id"),r.getLong("chat_id"),(Long)r.getObject("message_thread_id"),r.getLong("version"))).optional()
				.orElseThrow(()->bad("group_target_not_allowed")));
		return result;
	}
	/** Used by both the final start gate and explicit unknown retry; approval changes invalidate old snapshots. */
	@Transactional(propagation=Propagation.MANDATORY)
	public boolean deliveryAllowed(String delivery) {
		var target=jdbc.sql("select group_target_id from broadcast_targets t join notification_deliveries d on d.broadcast_target_id=t.id where d.id=:id")
				.param("id",delivery).query(String.class).optional();
		if(target.isEmpty())return false;
		jdbc.sql("select id from broadcast_group_targets where id=:id for share").param("id",target.get()).query(String.class).single();
		return jdbc.sql("""
				select g.active and g.version=t.approval_version and g.bot_id=t.bot_id and g.chat_id=t.chat_id
				and g.message_thread_id is not distinct from t.message_thread_id and d.chat_id=t.chat_id
				and d.message_thread_id is not distinct from t.message_thread_id and d.recipient_id is null and t.recipient_id is null
				from notification_deliveries d join broadcast_targets t on t.id=d.broadcast_target_id
				join broadcast_group_targets g on g.id=t.group_target_id where d.id=:id
				""").param("id",delivery).query((r,i)->r.getBoolean(1)).single();
	}
	private ApiException bad(String code) { return new ApiException(HttpStatus.BAD_REQUEST,code,"Выберите разрешённых адресатов рассылки"); }
	record Target(String id,String bot,long chat,Long thread,long version) {}
}
