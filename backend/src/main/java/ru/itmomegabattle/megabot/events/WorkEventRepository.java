package ru.itmomegabattle.megabot.events;

import java.util.List;

import org.springframework.data.jpa.repository.JpaRepository;

interface WorkEventRepository extends JpaRepository<WorkEventEntity, String> {

	List<WorkEventEntity> findAllByOrderByStartsAtAscNameAsc();
}
