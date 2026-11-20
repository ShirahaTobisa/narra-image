"use client";

import { HERO_STATS } from "./constants";
import { useHomeCountUp } from "./hooks/use-home-count-up";
import { useHomeVisibility } from "./hooks/use-home-visibility";
import styles from "./homepage.module.css";

export function HeroStats() {
  const { ref, visible } = useHomeVisibility<HTMLDivElement>();
  const progress = useHomeCountUp(visible);

  return (
    <div ref={ref} className={styles.stats} aria-label="创作数量限制" aria-describedby="home-stats-note">
      <dl className={styles.statGrid}>
        {HERO_STATS.map((stat) => (
          <div key={stat.id} className={styles.stat}>
            <dt className={styles.statLabel}>{stat.label}</dt>
            <dd className={styles.statValue}>
              <span className={styles.srOnly}>{stat.value} 张</span>
              <span aria-hidden data-home-stat={stat.id}>{Math.floor(stat.value * progress)} 张</span>
            </dd>
          </div>
        ))}
      </dl>
      <p id="home-stats-note" className={styles.statsNote}>按申请张数扣积分与计限额；生成耗时取决于排队和模型处理。</p>
    </div>
  );
}
