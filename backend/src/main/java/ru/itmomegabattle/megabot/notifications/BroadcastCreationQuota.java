package ru.itmomegabattle.megabot.notifications;

import java.time.Instant;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.common.ApiException;
import ru.itmomegabattle.megabot.common.SqlTime;

/** Per-actor fixed windows survive restarts; reservation rolls back with the broadcast command. */
@Service
class BroadcastCreationQuota {
    private final JdbcClient jdbc;
    private final long requestWindow,requestMax,volumeWindow,volumeMax;
    BroadcastCreationQuota(JdbcClient jdbc,
            @Value("${megabot.broadcast.request-window-ms:600000}") long requestWindow,
            @Value("${megabot.broadcast.request-max:10}") long requestMax,
            @Value("${megabot.broadcast.volume-window-ms:3600000}") long volumeWindow,
            @Value("${megabot.broadcast.volume-max:500}") long volumeMax) {
        if(requestWindow<1 || requestWindow>31536000000L || volumeWindow<1 || volumeWindow>31536000000L
                || requestMax<1 || requestMax>1000000 || volumeMax<1 || volumeMax>1000000000)
            throw new IllegalArgumentException("invalid_broadcast_creation_limits");
        this.jdbc=jdbc;this.requestWindow=requestWindow;this.requestMax=requestMax;this.volumeWindow=volumeWindow;this.volumeMax=volumeMax;
    }
    @Transactional(propagation=Propagation.MANDATORY)
    public void reserve(String actor,long recipients) {
        if(recipients<0)throw new IllegalArgumentException("invalid_broadcast_volume");
        jdbc.sql("insert into broadcast_creation_limits(author_id) values (:actor) on conflict do nothing").param("actor",actor).update();
        var bucket=jdbc.sql("select request_started_at,request_count,volume_started_at,volume_count from broadcast_creation_limits where author_id=:actor for update")
                .param("actor",actor).query((r,i)->new Bucket(r.getTimestamp(1).toInstant(),r.getLong(2),r.getTimestamp(3).toInstant(),r.getLong(4))).single();
        var now=jdbc.sql("select clock_timestamp()").query((r,i)->r.getTimestamp(1).toInstant()).single();
        var requestStart=now.isBefore(bucket.requestStart().plusMillis(requestWindow))?bucket.requestStart():now;
        var volumeStart=now.isBefore(bucket.volumeStart().plusMillis(volumeWindow))?bucket.volumeStart():now;
        var requests=requestStart.equals(now)?0:bucket.requests();
        var volume=volumeStart.equals(now)?0:bucket.volume();
        if(requests>=requestMax || recipients>volumeMax-volume)
            throw new ApiException(HttpStatus.TOO_MANY_REQUESTS,"broadcast_creation_rate_limited","Лимит рассылок или получателей исчерпан. Повторите позже.");
        jdbc.sql("update broadcast_creation_limits set request_started_at=:rs,request_count=:requests,volume_started_at=:vs,volume_count=:volume where author_id=:actor")
                .param("actor",actor).param("rs",SqlTime.of(requestStart)).param("requests",requests+1)
                .param("vs",SqlTime.of(volumeStart)).param("volume",volume+recipients).update();
    }
    private record Bucket(Instant requestStart,long requests,Instant volumeStart,long volume) {}
}
