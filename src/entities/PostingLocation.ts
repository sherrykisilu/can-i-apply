import 'reflect-metadata';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Location } from './Location.js';
import { Posting } from './Posting.js';

/**
 * Where a code came from.
 *
 * 'exact_match' means the raw text contained a country name that matched the ISO register
 * directly, with no model involvement. 'model_verified' means a model proposed it and the
 * verification gate accepted it. There is deliberately no value for 'the model said so', because
 * nothing reaches this table without passing the gate.
 */
export type EligibilityDerivation = 'exact_match' | 'model_verified';

/**
 * The join between a posting and a country it is eligible in.
 *
 * This is a first class entity rather than a plain TypeORM many to many join table because the
 * edge itself carries facts worth storing: how the code was derived and how confident the model
 * was. A posting may name thirty countries and a country may appear in thousands of postings, so
 * the relationship is genuinely many to many and flattening it into a text column on posting
 * would make the one query this project cares about impossible to index.
 */
@Entity({ name: 'posting_location' })
export class PostingLocation {
  @PrimaryColumn({ type: 'bigint', name: 'posting_id' })
  postingId!: string;

  @PrimaryColumn({ type: 'int', name: 'location_id' })
  locationId!: number;

  @ManyToOne(() => Posting, (posting) => posting.postingLocations, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'posting_id' })
  posting!: Posting;

  @ManyToOne(() => Location, (location) => location.postingLocations, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'location_id' })
  location!: Location;

  @Column({ type: 'varchar', length: 16 })
  derivation!: EligibilityDerivation;

  /** Model self reported confidence, 0 to 1. Null for exact matches, which need no model. */
  @Column({ type: 'real', nullable: true })
  confidence!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
