package ru.itmomegabattle.megabot.notifications;

import org.springframework.data.jpa.repository.JpaRepository;

interface OutboxEventRepository extends JpaRepository<OutboxEventEntity, String> {
}
