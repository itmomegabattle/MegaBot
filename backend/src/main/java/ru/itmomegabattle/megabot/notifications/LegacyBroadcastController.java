package ru.itmomegabattle.megabot.notifications;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.common.ApiException;
import ru.itmomegabattle.megabot.common.IdempotencyService;

/** Legacy field names only; domain scheduling, audience and delivery remain shared. */
@RestController
@PreAuthorize("hasAnyRole('ADMIN','ORGANIZER')")
class LegacyBroadcastController {
    private final BroadcastService broadcasts;
    private final IdempotencyService idempotency;
    private final JdbcClient jdbc;
    LegacyBroadcastController(BroadcastService broadcasts,IdempotencyService idempotency,JdbcClient jdbc) {
        this.broadcasts=broadcasts;this.idempotency=idempotency;this.jdbc=jdbc;
    }
    @PostMapping("/api/team/broadcast")
    ResponseEntity<Object> create(@Valid @RequestBody Create request,@AuthenticationPrincipal AuthenticatedUser actor,
            @RequestHeader("Idempotency-Key") String key) {
        var result=idempotency.execute(actor.id(),"legacy.team.broadcast",key,request,202,()->{
            var ids=new ArrayList<String>();
            if(request.competencies()!=null)for(var name:request.competencies().stream().map(String::strip).distinct().toList()) {
                ids.add(jdbc.sql("select id from competencies where name=:name and scope='core' and active")
                        .param("name",name).query(String.class).optional().orElseThrow(()->
                                new ApiException(HttpStatus.BAD_REQUEST,"invalid_broadcast_competency","Выберите действующую компетенцию команды")));
            }
            var weekIndex=request.availabilityWeekIndex()==null?0:request.availabilityWeekIndex();
            LocalDate week=null;
            if("missing_slots".equals(request.recipientMode())) {
                var today=jdbc.sql("select clock_timestamp()").query((r,i)->r.getTimestamp(1).toInstant()).single()
                        .atZone(ZoneId.of("Europe/Moscow")).toLocalDate();
                week=today.minusDays(today.getDayOfWeek().getValue()-1).plusWeeks(weekIndex);
            }
            var mutation=new BroadcastController.Mutation(request.title(),request.body(),request.recipientMode(),request.recipientIds(),
                    ids,week,request.dispatchMode()==null?"now":request.dispatchMode(),request.scheduledAt(),request.zoneId(),request.misfirePolicy(),request.silent(),null);
            var broadcast=broadcasts.create(mutation,actor);
            var targetCount=((Number)broadcast.get("targetCount")).longValue();
            var counts=(java.util.Map<?,?>)broadcast.get("deliveryCounts");
            var unavailable=counts.get("unavailable") instanceof Number count?count.longValue():0;
            var response=new LinkedHashMap<String,Object>();
            response.put("success",true);response.put("broadcastId",broadcast.get("id"));response.put("version",broadcast.get("version"));
            response.put("recipients",targetCount);response.put("queued",targetCount-unavailable);response.put("unavailable",unavailable);
            response.put("delivered",0);response.put("failed",0);response.put("pending",targetCount-unavailable);response.put("attention",0);
            response.put("deliveryStatus",broadcast.get("status"));response.put("availabilityWeekIndex",weekIndex);
            return response;
        });
        var response=ResponseEntity.status(result.status());
        if(result.replayed())response.header("Idempotency-Replayed","true");
        return response.body(result.body());
    }
    record Create(@Size(max=120) String title,@NotBlank @Size(max=40000) String body,
            @NotNull @Pattern(regexp="all|blocks|people|missing_slots") String recipientMode,
            @Size(max=2000) List<@NotBlank String> recipientIds,@Size(max=100) List<@NotBlank @Size(max=200) String> competencies,
            @Min(0) @Max(51) Integer availabilityWeekIndex,String dispatchMode,Instant scheduledAt,String zoneId,String misfirePolicy,Boolean silent) {}
}
