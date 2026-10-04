import { Module } from '@nestjs/common';
import { AppointmentsController } from './controllers/appointments.controller';
import { PractitionersController } from './controllers/practitioners.controller';
import { AppointmentsRepository } from './repositories/appointments.repository';
import { PractitionersRepository } from './repositories/practitioners.repository';
import { AppointmentsService } from './services/appointments.service';
import { PractitionersService } from './services/practitioners.service';

/** Module appointments : praticiens, agenda, rendez-vous (docs/03 §4.7). */
@Module({
  controllers: [PractitionersController, AppointmentsController],
  providers: [PractitionersService, AppointmentsService, PractitionersRepository, AppointmentsRepository],
})
export class AppointmentsModule {}
