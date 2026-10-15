import 'reflect-metadata';
import { Column, Entity, Index, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import type { PostingLocation } from './PostingLocation.js';

/**
 * One ISO 3166-1 alpha-2 country.
 *
 * Rows here are seeded from the committed ISO register in src/iso/countries.ts and are never
 * created from model output. If a country is not already in this table it does not exist as far
 * as the system is concerned, which makes the foreign key from posting_location a second,
 * database level enforcement of the same rule the verification gate enforces in the application.
 */
@Entity({ name: 'location' })
export class Location {
  @PrimaryGeneratedColumn('increment', { type: 'int' })
  id!: number;

  @Index('uq_location_country_code', { unique: true })
  @Column({ type: 'char', length: 2 })
  countryCode!: string;

  @Column({ type: 'varchar', length: 128 })
  countryName!: string;

  @OneToMany('PostingLocation', 'location')
  postingLocations!: PostingLocation[];
}
