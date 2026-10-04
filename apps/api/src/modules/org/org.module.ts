import { Module } from '@nestjs/common';
import { DepartmentsController } from './controllers/departments.controller';
import { SitesController } from './controllers/sites.controller';
import { DepartmentsService } from './services/departments.service';
import { SitesService } from './services/sites.service';

/** Module org : sites et services (docs/03 §4.3). */
@Module({
  controllers: [SitesController, DepartmentsController],
  providers: [SitesService, DepartmentsService],
})
export class OrgModule {}
