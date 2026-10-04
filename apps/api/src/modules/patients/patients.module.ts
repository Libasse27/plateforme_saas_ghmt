import { Module } from '@nestjs/common';
import { PatientsController } from './controllers/patients.controller';
import { PatientsRepository } from './repositories/patients.repository';
import { PatientsService } from './services/patients.service';

/** Module patients : identité administrative, recherche, dossier (docs/03 §4.6). */
@Module({
  controllers: [PatientsController],
  providers: [PatientsService, PatientsRepository],
})
export class PatientsModule {}
