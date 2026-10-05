package ru.itmomegabattle.megabot.notifications;

import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.availability.AvailabilitySubmissionService;
import ru.itmomegabattle.megabot.common.ApiException;
import ru.itmomegabattle.megabot.common.AuditWriter;
import ru.itmomegabattle.megabot.common.SqlTime;
import tools.jackson.databind.ObjectMapper;

@Service
class BroadcastService {
	private final JdbcClient jdbc;
	private final DeliveryQueue queue;
	private final ObjectMapper json;
	private final AuditWriter audit;
	private final AvailabilitySubmissionService availability;
	private final BroadcastCreationQuota creationQuota;
	private final BroadcastGroupTargets groups;
	BroadcastService(JdbcClient jdbc,DeliveryQueue queue,ObjectMapper json,AuditWriter audit,AvailabilitySubmissionService availability,BroadcastCreationQuota creationQuota,BroadcastGroupTargets groups) {
		this.jdbc=jdbc;this.queue=queue;this.json=json;this.audit=audit;this.availability=availability;
		this.creationQuota=creationQuota;
		this.groups=groups;
	}
	@Transactional
	public Map<String,Object> create(BroadcastController.Mutation r,AuthenticatedUser actor) {
		var plan=plan(r);var recipients=recipients(r,plan.mode());var id="broadcast_"+UUID.randomUUID();
		creationQuota.reserve(actor.id(),recipients.stream().filter(p->p.chatId()!=null).count()*plan.parts().size());
		jdbc.sql("""
				insert into broadcasts(id,author_id,title,content,scheduled_at,expires_at,zone_id,misfire_policy,status,recipient_mode,week_start)
				values (:id,:actor,:title,:body,:due,:expires,'Europe/Moscow',:policy,'scheduled',:mode,:week)
				""").param("id",id).param("actor",actor.id()).param("title",plan.title()).param("body",r.body().strip())
				.param("due",SqlTime.of(plan.due())).param("expires",SqlTime.of(plan.expires())).param("policy",plan.policy())
				.param("mode",plan.mode()).param("week",r.weekStart()).update();
		materialize(id,1,r,plan,recipients);audit.write(actor.id(),"broadcast",id,"created",Map.of("revision",1,"targets",recipients.size()));
		return view(require(id,false),actor);
	}
	@Transactional
	public Map<String,Object> update(String id,BroadcastController.Mutation r,AuthenticatedUser actor) {
		var b=require(id,true);owner(b,actor);version(b,r.expectedVersion());
		if(!"scheduled".equals(b.get("lifecycleStatus")) || jdbc.sql("select count(*) from notification_deliveries d join broadcast_targets t on t.id=d.broadcast_target_id where t.broadcast_id=:id and d.attempts>0")
				.param("id",id).query(Long.class).single()>0)throw conflict("broadcast_already_started");
		var plan=plan(r);var recipients=recipients(r,plan.mode());
		creationQuota.reserve(actor.id(),recipients.stream().filter(p->p.chatId()!=null).count()*plan.parts().size());cancelDeliveries(id);
		var revision=((Number)b.get("contentRevision")).longValue()+1;
		jdbc.sql("""
				update broadcasts set title=:title,content=:body,scheduled_at=:due,expires_at=:expires,misfire_policy=:policy,
				recipient_mode=:mode,week_start=:week,content_revision=:revision,version=version+1,updated_at=clock_timestamp() where id=:id
				""").param("id",id).param("title",plan.title()).param("body",r.body().strip()).param("due",SqlTime.of(plan.due()))
				.param("expires",SqlTime.of(plan.expires())).param("policy",plan.policy()).param("mode",plan.mode())
				.param("week",r.weekStart()).param("revision",revision).update();
		materialize(id,revision,r,plan,recipients);audit.write(actor.id(),"broadcast",id,"updated",Map.of("revision",revision,"targets",recipients.size()));
		return view(require(id,false),actor);
	}
	@Transactional
	public Map<String,Object> reschedule(String id,BroadcastController.Reschedule r,AuthenticatedUser actor) {
		var b=require(id,true);owner(b,actor);version(b,r.expectedVersion());
		// Same parent-before-delivery order as start; a claim alone must not prevent a safe transfer.
		jdbc.sql("select d.id from notification_deliveries d join broadcast_targets t on t.id=d.broadcast_target_id where t.broadcast_id=:id order by d.id for update of d")
				.param("id",id).query(String.class).list();
		if(!reschedulable(b))throw conflict("broadcast_not_reschedulable");
		var silent=jdbc.sql("select d.disable_notification from notification_deliveries d join broadcast_targets t on t.id=d.broadcast_target_id where t.broadcast_id=:id and t.revision=:revision limit 1")
				.param("id",id).param("revision",b.get("contentRevision")).query(Boolean.class).optional().orElse(false);
		var mutation=new BroadcastController.Mutation((String)b.get("title"),(String)b.get("body"),(String)b.get("recipientMode"),null,null,(LocalDate)b.get("weekStart"),
				"scheduled",r.scheduledAt(),(String)b.get("zoneId"),(String)b.get("misfirePolicy"),silent,r.expectedVersion());
		var plan=plan(mutation);
		var snapshot=jdbc.sql("select * from broadcast_targets where broadcast_id=:id and revision=:revision order by target_key")
				.param("id",id).param("revision",b.get("contentRevision")).query((row,i)->new Recipient(row.getString("recipient_id"),(Long)row.getObject("chat_id"),
						(Long)row.getObject("message_thread_id"),row.getString("bot_id"),row.getString("group_target_id"),(Long)row.getObject("approval_version"))).list();
		creationQuota.reserve(actor.id(),snapshot.stream().filter(p->p.chatId()!=null).count()*plan.parts().size());
		cancelDeliveries(id);var revision=((Number)b.get("contentRevision")).longValue()+1;
		jdbc.sql("update broadcasts set scheduled_at=:due,expires_at=:expires,content_revision=:revision,version=version+1,updated_at=clock_timestamp() where id=:id")
				.param("id",id).param("due",SqlTime.of(plan.due())).param("expires",SqlTime.of(plan.expires())).param("revision",revision).update();
		materialize(id,revision,mutation,plan,snapshot);
		audit.write(actor.id(),"broadcast",id,"rescheduled",Map.of("revision",revision,"scheduledAt",r.scheduledAt().toString(),"targets",snapshot.size()));
		return view(require(id,false),actor);
	}
	private boolean reschedulable(Map<String,Object> b) {
		return "scheduled".equals(b.get("lifecycleStatus")) && jdbc.sql("""
				select b.expires_at>clock_timestamp()
				and not exists(select 1 from notification_deliveries d join broadcast_targets t on t.id=d.broadcast_target_id where t.broadcast_id=b.id and d.attempts>0)
				and not exists(select 1 from notification_deliveries d join broadcast_targets t on t.id=d.broadcast_target_id where t.broadcast_id=b.id and t.revision=b.content_revision and (d.status not in ('planned','claimed') or d.cancel_requested))
				and not exists(select 1 from broadcast_expiry_notices n where n.broadcast_id=b.id and n.revision=b.content_revision)
				from broadcasts b where b.id=:id
				""").param("id",b.get("id")).query(Boolean.class).single();
	}
	@Transactional
	public Map<String,Object> cancel(String id,Long expectedVersion,AuthenticatedUser actor) {
		var b=require(id,true);owner(b,actor);version(b,expectedVersion);
		if("cancelled".equals(b.get("lifecycleStatus")))return view(b,actor);
		cancelDeliveries(id);
		jdbc.sql("update broadcasts set status='cancelled',version=version+1,updated_at=clock_timestamp() where id=:id").param("id",id).update();
		audit.write(actor.id(),"broadcast",id,"cancelled",Map.of("revision",b.get("contentRevision")));
		return view(require(id,false),actor);
	}
	@Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
	public Map<String,Object> get(String id,AuthenticatedUser actor) { return view(require(id,false),actor); }
	@Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
	public Map<String,Object> list(AuthenticatedUser actor,int limit,String cursor) {
		if(limit<1 || limit>100)throw bad("invalid_limit");var after=cursor==null?"":cursor;
		if(!after.isEmpty())owner(require(after,false),actor);
		var ids=jdbc.sql("select id from broadcasts where (:admin or author_id=:actor) and id>:cursor order by id limit :limit")
				.param("admin","admin".equals(actor.role())).param("actor",actor.id()).param("cursor",after).param("limit",limit+1).query(String.class).list();
		var more=ids.size()>limit;var selected=more?ids.subList(0,limit):ids;
		var response=new LinkedHashMap<String,Object>();response.put("items",selected.stream().map(id->view(require(id,false),actor)).toList());
		response.put("nextCursor",more?selected.getLast():null);return response;
	}
	private Plan plan(BroadcastController.Mutation r) {
		if(r.zoneId()!=null && !"Europe/Moscow".equals(r.zoneId()))throw bad("invalid_broadcast_zone");
		var now=jdbc.sql("select clock_timestamp()").query((row,i)->row.getTimestamp(1).toInstant()).single();
		var mode=r.dispatchMode()==null?"scheduled":r.dispatchMode();Instant due;
		if("now".equals(mode)) { if(r.scheduledAt()!=null)throw bad("immediate_has_schedule");due=now; }
		else if("scheduled".equals(mode)) {
			due=r.scheduledAt();if(due==null || due.isBefore(now.plusSeconds(30)) || due.isAfter(now.plusSeconds(365L*86400)))throw bad("invalid_broadcast_schedule");
		}else throw bad("invalid_dispatch_mode");
		var title=r.title()==null?"":r.title().strip();var text=title.isEmpty()?r.body().strip():title+"\n\n"+r.body().strip();
		var parts=BroadcastText.split(text);
		var policy=r.misfirePolicy()==null?"send_late":r.misfirePolicy();
		if(!List.of("send_late","skip").contains(policy))throw bad("invalid_misfire_policy");
		return new Plan(due,due.plusSeconds("skip".equals(policy)?5:900),"skip".equals(policy)?"skip":"send_within_grace",
				r.recipientMode()==null?"people":r.recipientMode(),title,parts);
	}
	private List<Recipient> recipients(BroadcastController.Mutation r,String mode) {
		if("groups".equals(mode)) {
			if(r.weekStart()!=null || r.recipientIds()!=null && !r.recipientIds().isEmpty() || r.competencyIds()!=null && !r.competencyIds().isEmpty())throw bad("mixed_group_audience");
			return groups.snapshot(r.groupTargetIds()).stream().map(g->new Recipient(null,g.chat(),g.thread(),g.bot(),g.id(),g.version())).toList();
		}
		if(r.groupTargetIds()!=null && !r.groupTargetIds().isEmpty())throw bad("unexpected_group_targets");
		if(!List.of("people","all","blocks","missing_slots").contains(mode))throw bad("invalid_recipient_mode");
		var ids=r.recipientIds()==null?List.<String>of():r.recipientIds().stream().distinct().toList();
		for(var id:ids)if(jdbc.sql("select count(*) from users where id=:id and active and registered and role in ('admin','organizer')")
				.param("id",id).query(Long.class).single()==0)throw bad("invalid_broadcast_recipient");
		var competencies=r.competencyIds()==null?List.<String>of():r.competencyIds().stream().distinct().toList();
		for(var id:competencies)if(jdbc.sql("select count(*) from competencies where id=:id and active and scope='core'").param("id",id).query(Long.class).single()==0)throw bad("invalid_broadcast_competency");
		if("people".equals(mode) && ids.isEmpty() || "blocks".equals(mode) && competencies.isEmpty())throw bad("empty_broadcast_audience");
		if("missing_slots".equals(mode))availability.validateWeek(r.weekStart());
		else if(r.weekStart()!=null)throw bad("unexpected_broadcast_week");
		var targets=jdbc.sql("select id,telegram_id from users where active and registered and role in ('admin','organizer') order by id")
				.query((row,i)->new Recipient(row.getString("id"),(Long)row.getObject("telegram_id"))).list().stream()
				.filter(p->switch(mode) {
					case "people"->ids.contains(p.id());case "blocks"->ids.contains(p.id()) || jdbc.sql("select count(*) from user_competencies where user_id=:id and competency_id in (:ids)").param("id",p.id()).param("ids",competencies).query(Long.class).single()>0;
					case "missing_slots"->!availability.submitted(p.id(),r.weekStart());default->true;
				}).toList();
		if(targets.isEmpty())throw bad("empty_broadcast_audience");return targets;
	}
	private void materialize(String id,long revision,BroadcastController.Mutation r,Plan plan,List<Recipient> recipients) {
		for(var p:recipients) {
			var target="target_"+UUID.randomUUID();
			jdbc.sql("insert into broadcast_targets(id,broadcast_id,revision,target_key,recipient_id,chat_id,availability,message_thread_id,bot_id,group_target_id,approval_version,part_count) values (:target,:id,:revision,:key,:recipient,:chat,:availability,:thread,:bot,:group,:approval,:count)")
					.param("target",target).param("id",id).param("revision",revision).param("key",p.key()).param("recipient",p.id())
					.param("chat",p.chatId()).param("availability",p.chatId()==null?"unavailable":"ready")
					.param("thread",p.thread()).param("bot",p.bot()).param("group",p.group()).param("approval",p.approval()).param("count",plan.parts().size()).update();
			if(p.chatId()!=null) {
				for(int i=0;i<plan.parts().size();i++) {
					var payload=json.writeValueAsString(Map.of("text",plan.parts().get(i),"broadcastId",id,"contentRevision",revision));
					var key=id+":"+revision+":"+(p.group()==null?p.id():p.key())+(i==0?"":":part:"+(i+1));
					var delivery=queue.enqueue(new DeliveryQueue.NewDelivery(id,key,"broadcast",p.id(),p.chatId(),p.thread(),payload,Boolean.TRUE.equals(r.silent()),plan.due(),plan.due(),plan.expires()));
					jdbc.sql("update notification_deliveries set broadcast_target_id=:target,part_number=:number,part_count=:count where id=:id")
							.param("target",target).param("number",i+1).param("count",plan.parts().size()).param("id",delivery).update();
				}
			}
		}
	}
	private void cancelDeliveries(String id) {
		for(var delivery:jdbc.sql("""
				select d.id from notification_deliveries d where
				exists(select 1 from broadcast_targets t where t.id=d.broadcast_target_id and t.broadcast_id=:id)
				or exists(select 1 from broadcast_expiry_notices n where n.id=d.broadcast_expiry_notice_id and n.broadcast_id=:id)
				order by d.id
				""").param("id",id).query(String.class).list())queue.cancel(delivery);
	}
	private Map<String,Object> require(String id,boolean lock) {
		return jdbc.sql("select * from broadcasts where id=:id"+(lock?" for update":"")).param("id",id).query((row,i)->{
			var b=new LinkedHashMap<String,Object>();b.put("id",id);b.put("authorId",row.getString("author_id"));b.put("title",row.getString("title"));b.put("body",row.getString("content"));
			var scheduled=row.getTimestamp("scheduled_at");b.put("scheduledAt",scheduled==null?null:scheduled.toInstant());b.put("zoneId",row.getString("zone_id"));b.put("misfirePolicy","skip".equals(row.getString("misfire_policy"))?"skip":"send_late");
			b.put("lifecycleStatus",row.getString("status"));b.put("version",row.getLong("version"));b.put("contentRevision",row.getLong("content_revision"));
			b.put("recipientMode",row.getString("recipient_mode"));var week=row.getDate("week_start");b.put("weekStart",week==null?null:week.toLocalDate());return (Map<String,Object>)b;
		}).optional().orElseThrow(()->new ApiException(HttpStatus.NOT_FOUND,"broadcast_not_found","Рассылка не найдена"));
	}
	private Map<String,Object> view(Map<String,Object> b,AuthenticatedUser actor) {
		owner(b,actor);var id=b.get("id");var revision=b.get("contentRevision");
		var targets=jdbc.sql("""
				select * from broadcast_target_delivery_summary where broadcast_id=:id and revision=:revision order by target_key
				""").param("id",id).param("revision",revision).query((row,i)->{
					var target=new LinkedHashMap<String,Object>();target.put("recipientId",row.getString("recipient_id"));
					if(row.getString("group_target_id")!=null)target.put("groupTargetId",row.getString("group_target_id"));
					target.put("status",row.getString("status"));target.put("partCount",row.getInt("part_count"));target.put("partCounts",json.readTree(row.getString("part_counts")));return target;
				}).list();
		var counts=new LinkedHashMap<String,Long>();for(var target:targets)counts.merge((String)target.get("status"),1L,Long::sum);
		var status="scheduled";var sent=counts.getOrDefault("sent",0L);var pending=counts.getOrDefault("planned",0L)+counts.getOrDefault("retry",0L)+counts.getOrDefault("claimed",0L)+counts.getOrDefault("sending",0L);
		if("cancelled".equals(b.get("lifecycleStatus")))status="cancelled";
		else if(targets.isEmpty())status=(String)b.get("lifecycleStatus");else if(sent==targets.size())status="sent";else if(sent>0 || counts.getOrDefault("partial",0L)>0)status="partial";else if(counts.getOrDefault("unknown",0L)>0)status="unknown";
		else if(pending==0)status=counts.getOrDefault("expired",0L)>0?"expired":"failed";
		else if(counts.getOrDefault("sending",0L)+counts.getOrDefault("claimed",0L)>0)status="sending";
		var response=new LinkedHashMap<String,Object>(b);response.put("status",status);response.put("targets",targets);response.put("targetCount",targets.size());response.put("deliveryCounts",counts);
		response.put("reschedulable",reschedulable(b));
		response.put("expiryNotice",jdbc.sql("""
				select n.id,coalesce(d.status,n.state) as status,n.created_at,n.expires_at from broadcast_expiry_notices n
				left join notification_deliveries d on d.broadcast_expiry_notice_id=n.id
				where n.broadcast_id=:id and n.revision=:revision
				""").param("id",id).param("revision",revision).query((r,i)->Map.<String,Object>of("id",r.getString("id"),"status",r.getString("status"),"createdAt",r.getTimestamp("created_at").toInstant(),"expiresAt",r.getTimestamp("expires_at").toInstant())).optional().orElse(null));
		return response;
	}
	Map<String,Object> accessible(String id,AuthenticatedUser actor,boolean lock) { var b=require(id,lock);owner(b,actor);return b; }
	private void owner(Map<String,Object> b,AuthenticatedUser actor) { if(!"admin".equals(actor.role()) && !actor.id().equals(b.get("authorId")))throw new ApiException(HttpStatus.FORBIDDEN,"broadcast_access_denied","Нет доступа к рассылке"); }
	private void version(Map<String,Object> b,Long expected) { if(expected==null)throw bad("version_required");if(((Number)b.get("version")).longValue()!=expected)throw conflict("stale_version"); }
	private ApiException bad(String code) { return new ApiException(HttpStatus.BAD_REQUEST,code,"Проверьте параметры рассылки и время МСК"); }
	private ApiException conflict(String code) { return new ApiException(HttpStatus.CONFLICT,code,"Рассылка изменилась или отправка уже началась"); }
	private record Plan(Instant due,Instant expires,String policy,String mode,String title,List<String> parts) {}
	private record Recipient(String id,Long chatId,Long thread,String bot,String group,Long approval) {
		Recipient(String id,Long chatId) { this(id,chatId,null,null,null,null); }
		String key() { return group==null?"user:"+id:"group:"+group; }
	}
}
