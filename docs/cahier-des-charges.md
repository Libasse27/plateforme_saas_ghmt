# Cahier des charges initial — plateforme SaaS de gestion des établissements de santé

> Expression de besoin d'origine, fournie par le porteur du projet. Elle a servi de base aux documents `00` à `06`.
> Le suivi de sa réalisation est tenu dans `12-schema-de-travail.md` (matrice de traçabilité §2).

Je souhaite concevoir et développer un **nouveau projet SaaS complet de gestion des établissements de santé**, basé sur une architecture **multi-tenant, multi-utilisateur et modulaire**.

L'objectif est de créer une plateforme centralisée permettant à différents établissements de santé de venir **créer, configurer et gérer leur propre système d'information hospitalier**, sans que les données d'un établissement soient accessibles à un autre.

## 1. Concept général de la plateforme

La plateforme doit fonctionner comme un **SaaS de gestion hospitalière**. Un établissement peut s'inscrire sur la plateforme et créer son propre environnement de gestion en fonction de son type et de ses besoins.

Types d'établissements pris en charge : hôpital de niveau 1, 2 et 3 ; centre médicalisé ; centre de santé ; clinique médicale ; cabinet médical ; laboratoire ; pharmacie ; centre de diagnostic ; centre de soins spécialisé ; autres structures sanitaires.

Chaque établissement doit pouvoir activer uniquement les modules dont il a besoin.

## 2. Architecture multi-tenant

Chaque établissement constitue un **tenant indépendant** avec ses propres utilisateurs, patients, médecins et employés, services, dossiers médicaux, rendez-vous, stocks, pharmacie, comptabilité, paramètres, rapports et données.

Les données doivent être strictement isolées entre les établissements. Un utilisateur d'un établissement ne doit jamais pouvoir consulter ou modifier les données d'un autre établissement, sauf autorisation explicite du **Super Administrateur**.

## 3. Super Administrateur

Un **Super Administrateur global** a une vision et un contrôle centralisés sur l'ensemble du SaaS. Il doit pouvoir :
- créer, modifier, suspendre ou supprimer un établissement ;
- gérer les abonnements SaaS et définir les plans tarifaires ;
- activer ou désactiver des modules ;
- gérer les administrateurs de chaque établissement ;
- consulter les statistiques globales et surveiller l'activité de la plateforme ;
- gérer les licences, les droits et permissions globaux ;
- consulter les journaux d'audit ;
- gérer les paramètres généraux, superviser les tenants ;
- gérer les intégrations et les API ;
- effectuer les opérations de maintenance.

Le système doit respecter une séparation claire entre les données et les responsabilités de chaque établissement.

## 4. Gestion des utilisateurs et des rôles

Système **multi-utilisateur** avec gestion avancée des rôles et permissions. Profils : Super Administrateur, administrateur de l'établissement, directeur, médecin, infirmier, sage-femme, pharmacien, technicien de laboratoire, réceptionniste, agent administratif, comptable, responsable RH, gestionnaire de stock, caissier, patient, autres selon les besoins.

Permissions configurables (RBAC) : ce qu'un utilisateur peut consulter, créer, modifier, supprimer, valider, et les modules auxquels il accède.

## 5. Modules du système

- **A. Patients** : enregistrement, identification, dossier patient, historique médical, antécédents, allergies, groupe sanguin, consultations, hospitalisations, ordonnances, examens, résultats, documents médicaux, facturation, historique des soins.
- **B. Rendez-vous** : prise, modification, annulation, confirmation, rappel, calendrier des médecins, disponibilité des services, files d'attente. Application mobile patients : créer un compte, rechercher un établissement, choisir un service ou un médecin, consulter les disponibilités, prendre, modifier ou annuler un rendez-vous, recevoir des notifications, consulter l'historique.
- **C. Gestion médicale** : consultations, diagnostic, prescription, ordonnances, suivi médical, actes médicaux, soins infirmiers, hospitalisation, sortie du patient, dossier médical électronique.
- **D. Laboratoire** : demandes d'analyses, prélèvements, gestion des examens, résultats, validation, impression des comptes rendus, historique.
- **E. Pharmacie** : médicaments, entrées et sorties, stocks, lots, dates d'expiration, fournisseurs, ventes, ordonnances, alertes de stock et d'expiration.
- **F. Stocks** : produits, fournisseurs, commandes, réceptions, inventaires, mouvements, seuils minimum, alertes, traçabilité.
- **G. Ressources humaines** (spécialisées santé) : dossiers des employés, contrats, postes, départements, planning, présences, absences, congés, paie, évaluations, formations, documents administratifs, historique professionnel.
- **H. Comptabilité et finances** (adaptées santé) : recettes, dépenses, caisse, banque, facturation, paiements, dettes, créances, fournisseurs, budgets, rapports financiers, journal comptable, états financiers.
- **I. Assurance et prise en charge** : assurances maladie, organismes de prise en charge, contrats, taux de couverture, tickets modérateurs, facturation aux assurances, suivi des remboursements, rejets et régularisations.

## 6. Applications et moyens d'accès

- **Web** : interface complète pour l'administration, la gestion hospitalière, les médecins, les infirmiers, la pharmacie, la comptabilité, les RH, les responsables.
- **Desktop** : application installée localement pour certains services administratifs ou médicaux, communiquant avec le système central par l'API.
- **Mobile** : principalement pour les patients (inscription, authentification, recherche d'établissement, de médecin ou de service, prise, consultation, modification et annulation de rendez-vous, notifications, rappels, informations personnelles). Une application pour les professionnels de santé pourra suivre.
- **API** REST (ou GraphQL) : authentification, autorisation, tenants, utilisateurs, patients, rendez-vous, dossiers médicaux, facturation, pharmacie, stocks, RH, comptabilité, notifications, intégrations externes.

## 7. Sécurité

Priorité absolue : authentification sécurisée, rôles et permissions, authentification à deux facteurs, chiffrement des données sensibles et des communications, journalisation des activités, traçabilité des accès, audit des modifications, sauvegardes automatiques, restauration, protection contre les accès non autorisés, isolation stricte des tenants, gestion des sessions, politique de mots de passe, récupération de compte. Toutes les opérations sensibles sont enregistrées dans un **journal d'audit**.

## 8. Architecture technique

Architecture moderne, évolutive, sécurisée et maintenable, séparant : frontend web, application desktop, application mobile, API backend, base de données, services d'authentification, services de notifications, gestion des fichiers et documents, journalisation, sauvegarde, administration SaaS. L'ajout de nouveaux modules doit être facile.

## 9. Abonnements SaaS

Plans (exemples : Basic, Standard, Professional, Enterprise) définissant : nombre d'utilisateurs, de patients, de sites ; modules disponibles ; espace de stockage ; nombre de rendez-vous ; fonctionnalités avancées ; accès API ; support ; durée. Le Super Administrateur crée et modifie les plans.

## 10. Multi-sites

Structure **Groupe → Établissement → Site → Service → Utilisateurs**. Les permissions peuvent être définies au niveau du groupe, de l'établissement, du site ou du service.

## 11. Tableaux de bord

Chaque niveau dispose d'un tableau de bord adapté. Super Administrateur : établissements (total, actifs), utilisateurs, patients, rendez-vous, abonnements, revenus, activité, alertes, incidents, statistiques globales. Chaque établissement a son propre tableau de bord.

## 12. Notifications

Système centralisé : web, mobile, SMS, e-mail, notifications internes. Exemples : rappel, confirmation et annulation de rendez-vous ; résultat disponible ; expiration d'un médicament ; stock faible ; renouvellement d'abonnement ; notification administrative.

## 13. Objectif final

Une **véritable plateforme SaaS hospitalière complète**, pas l'application d'un seul hôpital. Un nouvel établissement doit pouvoir :
1. créer son compte ;
2. choisir son type d'établissement ;
3. sélectionner ses modules ;
4. configurer son établissement ;
5. créer ses utilisateurs ;
6. définir les rôles et permissions ;
7. configurer ses services ;
8. gérer patients, rendez-vous, soins, stocks, pharmacie, RH et finances.

Le système doit accueillir un grand nombre d'établissements, d'utilisateurs et de patients, en garantissant sécurité, confidentialité, disponibilité et isolation des données.

## 14. Livrables de conception attendus

Architecture générale et multi-tenant ; architecture et modèle de la base de données (tables, relations) ; diagrammes des modules, des utilisateurs et rôles ; modèle des permissions ; architecture et endpoints de l'API ; architectures web, desktop et mobile ; authentification ; RBAC ; abonnements SaaS ; notifications ; journalisation et audit ; sauvegardes ; sécurité ; déploiement ; recommandations technologiques ; phases de développement ; MVP ; fonctionnalités des versions suivantes. La conception doit être scalable, sécurisée, modulaire, maintenable et commercialisable.
