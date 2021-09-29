import PricingDefinition, { DimensionType, PricedConsumptionData, PricedDimensionData, PricingDimension, PricingRestriction, ResolvedPricingModel } from '../../types/Pricing';

import Consumption from '../../types/Consumption';
import Tenant from '../../types/Tenant';
import Utils from '../../utils/Utils';
import moment from 'moment';

export default class ConsumptionPricer {

  tenant: Tenant;
  pricingModel: ResolvedPricingModel;
  consumptionData: Consumption;
  actualPricingDefinitions: PricingDefinition[];

  constructor(tenant: Tenant, pricingModel: ResolvedPricingModel, consumptionData: Consumption) {
    this.tenant = tenant;
    this.pricingModel = pricingModel;
    this.consumptionData = consumptionData;
    const actualPricingDefinitions = this.pricingModel.pricingDefinitions.filter((pricingDefinition) =>
      this.checkPricingDefinitionRestrictions(pricingDefinition)
    );
    // It does not make sense to apply several tariffs to a single consumption
    this.actualPricingDefinitions = [ actualPricingDefinitions?.[0] ];
  }

  public priceConsumption(): PricedConsumptionData {
    // Price the consumption data for each dimension
    const flatFee = this.priceFlatFeeConsumption();
    const energy = this.priceEnergyConsumption();
    const chargingTime = this.priceChargingTimeConsumption();
    const parkingTime = this.priceParkingTimeConsumption();
    // Return all dimensions
    const pricingConsumptionData: PricedConsumptionData = {
      flatFee,
      energy,
      chargingTime,
      parkingTime
    };
    return pricingConsumptionData;
  }

  private checkPricingDefinitionRestrictions(pricingDefinition: PricingDefinition) : PricingDefinition {
    if (pricingDefinition.restrictions) {
      if (!this.checkMinEnergy(pricingDefinition.restrictions)
        || !this.checkMaxEnergy(pricingDefinition.restrictions)
        || !this.checkMinDuration(pricingDefinition.restrictions)
        || !this.checkMaxDuration(pricingDefinition.restrictions)) {
        // ---------------------------------------------------
        // TODO - additional restrictions may be checked here
        // ---------------------------------------------------
        // startTime?: string, // Start time of day, for example 13:30, valid from this time of the day. Must be in 24h format with leading zeros. Hour/Minute se
        // endTime?: string, // End time of day, for example 19:45, valid until this time of the day. Same syntax as start_time
        // startDate?: string, // Start date, for example: 2015-12-24, valid from this day
        // endDate?: string, // End date, for example: 2015-12-27, valid until this day (excluding this day)
        // daysOfWeek?: DayOfWeek[], // Which day(s) of the week this tariff is valid
        return null;
      }
    }
    // a definition matching the restrictions has been found
    return pricingDefinition;
  }

  private checkMinEnergy(restrictions: PricingRestriction): boolean {
    if (!Utils.isNullOrUndefined(restrictions.minEnergyKWh)) {
      if (Utils.createDecimal(this.consumptionData.cumulatedConsumptionWh).div(1000).lessThan(restrictions.minEnergyKWh)) {
        return false;
      }
    }
    return true;
  }

  private checkMaxEnergy(restrictions: PricingRestriction): boolean {
    if (!Utils.isNullOrUndefined(restrictions.maxEnergyKWh)) {
      if (Utils.createDecimal(this.consumptionData.cumulatedConsumptionWh).div(1000).greaterThanOrEqualTo(restrictions.maxEnergyKWh)) {
        return false;
      }
    }
    return true;
  }

  private checkMinDuration(restrictions: PricingRestriction): boolean {
    if (!Utils.isNullOrUndefined(restrictions.minDurationSecs)) {
      if (Utils.createDecimal(this.consumptionData.totalDurationSecs).lessThan(restrictions.minDurationSecs)) {
        return false;
      }
      return true;
    }
    return true;
  }

  private checkMaxDuration(restrictions: PricingRestriction): boolean {
    if (!Utils.isNullOrUndefined(restrictions.maxDurationSecs)) {
      if (Utils.createDecimal(this.consumptionData.totalDurationSecs).greaterThanOrEqualTo(restrictions.maxDurationSecs)) {
        return false;
      }
    }
    return true;
  }

  private priceFlatFeeConsumption(): PricedDimensionData {
    // Flat fee must be priced only once
    if (!this.pricingModel.pricerContext.flatFeeAlreadyPriced) {
      const activePricingDefinition = this.getActiveDefinition4Dimension(this.actualPricingDefinitions, DimensionType.FLAT_FEE);
      if (activePricingDefinition) {
        const dimensionToPrice = activePricingDefinition.dimensions.flatFee;
        const pricedData = this.priceFlatFeeDimension(dimensionToPrice);
        if (pricedData) {
          pricedData.sourceName = activePricingDefinition.name;
          this.pricingModel.pricerContext.flatFeeAlreadyPriced = true;
        }
        return pricedData;
      }
    }
  }

  private priceEnergyConsumption(): PricedDimensionData {
    const activePricingDefinition = this.getActiveDefinition4Dimension(this.actualPricingDefinitions, DimensionType.ENERGY);
    if (activePricingDefinition) {
      let pricedData: PricedDimensionData;
      const dimensionToPrice = activePricingDefinition.dimensions.energy;
      const consumptionWh = this.consumptionData?.consumptionWh || 0;
      if (dimensionToPrice.stepSize) {
        if (this.consumptionData.cumulatedConsumptionWh > 0) {
          const delta = Utils.createDecimal(this.consumptionData.cumulatedConsumptionWh).minus(this.getAbsorbedConsumption());
          const nbSteps = delta.divToInt(dimensionToPrice.stepSize).toNumber();
          if (nbSteps > 0) {
            pricedData = this.priceConsumptionStep(dimensionToPrice, nbSteps);
            this.absorbConsumption();
          }
        }
      } else if (consumptionWh > 0) {
        pricedData = this.priceConsumptionWh(dimensionToPrice, consumptionWh);
        this.absorbConsumption();
      }
      return this.enrichPricedData(pricedData, activePricingDefinition);

    }
    // IMPORTANT!
    this.absorbConsumption();
  }

  private enrichPricedData(pricedData: PricedDimensionData, activePricingDefinition: PricingDefinition) : PricedDimensionData {
    if (pricedData) {
      pricedData.sourceName = activePricingDefinition.name;
    }
    return pricedData;
  }

  private getAbsorbedConsumption() {
    return this.pricingModel.pricerContext.lastAbsorbedConsumption || 0;
  }

  private absorbConsumption() {
    // Mark the consumed energy as already priced - to avoid pricing it twice
    // This may happen when combining several tariffs in a single session
    this.pricingModel.pricerContext.lastAbsorbedConsumption = this.consumptionData.cumulatedConsumptionWh;
  }

  private priceChargingTimeConsumption(): PricedDimensionData {
    const activePricingDefinition = this.getActiveDefinition4Dimension(this.actualPricingDefinitions, DimensionType.CHARGING_TIME);
    if (activePricingDefinition) {
      const dimensionToPrice = activePricingDefinition.dimensions.chargingTime;
      const consumptionWh = this.consumptionData?.consumptionWh || 0;
      // Price the charging time only when charging!
      if (consumptionWh > 0) {
        const pricedData = this.priceTimeDimension(dimensionToPrice, this.getAbsorbedChargingTime());
        if (pricedData) {
          this.absorbedChargingTime();
        }
        return this.enrichPricedData(pricedData, activePricingDefinition);
      }
    }
    // IMPORTANT!
    this.absorbedChargingTime();
  }

  private getAbsorbedChargingTime() {
    return this.pricingModel.pricerContext.lastAbsorbedChargingTime || this.pricingModel.pricerContext.sessionStartDate;
  }

  private absorbedChargingTime() {
    // Mark the charging time as already priced - to avoid pricing it twice
    // This may happen when combining several tariffs in a single session
    this.pricingModel.pricerContext.lastAbsorbedChargingTime = this.consumptionData.endedAt;
  }

  private priceParkingTimeConsumption(): PricedDimensionData {
    const activePricingDefinition = this.getActiveDefinition4Dimension(this.actualPricingDefinitions, DimensionType.PARKING_TIME);
    if (activePricingDefinition) {
      const dimensionToPrice = activePricingDefinition.dimensions.parkingTime;
      const totalInactivitySecs = this.consumptionData?.totalInactivitySecs || 0;
      const cumulatedConsumptionDataWh = this.consumptionData?.cumulatedConsumptionWh || 0;
      const consumptionWh = this.consumptionData?.consumptionWh || 0;
      // Price the parking time only it makes sense - NOT during the warmup!
      if (totalInactivitySecs > 0 && cumulatedConsumptionDataWh > 0 && consumptionWh <= 0) {
        // TODO - to be clarified - do we pay the first step before consuming it or not?
        const pricedData = this.priceTimeDimension(dimensionToPrice, this.getAbsorbedParkingTime());
        if (pricedData) {
          this.absorbedParkingTime();
        }
        return this.enrichPricedData(pricedData, activePricingDefinition);
      }
    }
    // IMPORTANT!
    this.absorbedParkingTime();
  }

  private getAbsorbedParkingTime() {
    return this.pricingModel.pricerContext.lastAbsorbedParkingTime || this.pricingModel.pricerContext.sessionStartDate;
  }

  private absorbedParkingTime() {
    // Mark the parking time as already priced - to avoid pricing it twice
    // This may happen when combining several tariffs in a single session
    this.pricingModel.pricerContext.lastAbsorbedParkingTime = this.consumptionData.endedAt;
  }

  private getActiveDefinition4Dimension(actualPricingDefinitions: PricingDefinition[], dimensionType: string): PricingDefinition {
    // Search for the first pricing definition matching the current dimension type
    return actualPricingDefinitions.find((pricingDefinition) =>
      this.checkPricingDimensionRestrictions(pricingDefinition, dimensionType)
    );
  }

  private checkPricingDimensionRestrictions(pricingDefinition: PricingDefinition, dimensionType: string) : PricingDefinition {
    const pricingDimension: PricingDimension = pricingDefinition.dimensions[dimensionType];
    if (pricingDimension?.active) {
      return pricingDefinition;
    }
    return null;
  }

  private priceFlatFeeDimension(pricingDimension: PricingDimension): PricedDimensionData {
    const unitPrice = pricingDimension.price || 0;
    if (pricingDimension.pricedData) {
      // This should not happen for the flatFee dimension - Flat Fee is billed only once per session
      // throw new Error('Unexpected situation - priceFlatFeeDimension should be called only once per session');
      return {
        unitPrice: 0,
        amount: 0,
        roundedAmount: 0,
        quantity: 0 // Session
      };
    }
    // First call for this dimension
    pricingDimension.pricedData = {
      unitPrice: unitPrice,
      amount: unitPrice,
      roundedAmount: Utils.truncTo(unitPrice, 2),
      quantity: 1 // Session
    };
    return pricingDimension.pricedData;
  }

  private priceConsumptionStep(pricingDimension: PricingDimension, steps: number): PricedDimensionData {
    const unitPrice = pricingDimension.price || 0; // Eur/wWh
    const quantity = Utils.createDecimal(steps).times(pricingDimension.stepSize).toNumber(); // Wh
    const amount = Utils.createDecimal(unitPrice).times(quantity).div(1000).toNumber(); // Eur
    // Price the consumption
    const pricedData: PricedDimensionData = {
      unitPrice: unitPrice,
      amount,
      roundedAmount: Utils.truncTo(amount, 2),
      quantity,
      stepSize: pricingDimension.stepSize,
    };
    // Add the consumption to the previous data (if any) - for the billing
    this.addPricedData(pricingDimension, pricedData);
    // Return the current consumption!
    return pricedData;
  }

  private priceConsumptionWh(pricingDimension: PricingDimension, consumptionWh: number): PricedDimensionData {
    const unitPrice = pricingDimension.price || 0; // Eur/kWh
    const quantity = Utils.createDecimal(consumptionWh).toNumber(); // Wh
    const amount = Utils.createDecimal(unitPrice).times(consumptionWh).div(1000).toNumber(); // Eur
    // const consumptionkWh = Utils.createDecimal(consumptionWh).div(1000).toNumber();
    // Price the consumption
    const pricedData: PricedDimensionData = {
      unitPrice: unitPrice,
      amount,
      roundedAmount: Utils.truncTo(amount, 2),
      quantity
    };
    // Add the consumption to the previous data (if any) - for the billing
    this.addPricedData(pricingDimension, pricedData);
    // Return the current consumption!
    return pricedData;
  }

  private priceTimeDimension(pricingDimension: PricingDimension, lastStepDate: Date): PricedDimensionData {
    // Is there a step size
    if (pricingDimension.stepSize) {
      // Price the charging time only when charging!
      // TODO - to be clarified - do we pay the first step before consuming it or not?
      const timeSpent = moment(this.consumptionData.endedAt).diff(moment(lastStepDate), 'seconds');
      const nbSteps = Utils.createDecimal(timeSpent).divToInt(pricingDimension.stepSize).toNumber();
      if (nbSteps > 0) {
        return this.priceTimeSteps(pricingDimension, nbSteps);
      }
    } else {
      const seconds = moment(this.consumptionData.endedAt).diff(moment(this.consumptionData.startedAt), 'seconds');
      if (seconds > 0) {
        return this.priceTimeSpent(pricingDimension, seconds);
      }
    }
  }

  private priceTimeSteps(pricingDimension: PricingDimension, steps: number): PricedDimensionData {
    const unitPrice = pricingDimension.price || 0; // Eur/hour
    const quantity = Utils.createDecimal(steps).times(pricingDimension.stepSize).toNumber(); // seconds
    const amount = Utils.createDecimal(unitPrice).times(quantity).div(3600).toNumber(); // Eur
    // Price the consumption
    const pricedData: PricedDimensionData = {
      unitPrice: unitPrice,
      amount,
      roundedAmount: Utils.truncTo(amount, 2),
      quantity,
      stepSize: pricingDimension.stepSize
    };
    // Add the consumption to the previous data (if any) - for the billing
    this.addPricedData(pricingDimension, pricedData);
    // Return the current consumption!
    return pricedData;
  }

  private priceTimeSpent(pricingDimension: PricingDimension, seconds: number): PricedDimensionData {
    const unitPrice = pricingDimension.price || 0; // Eur/hour
    const amount = Utils.createDecimal(unitPrice).times(seconds).div(3600).toNumber(); // Eur
    // Price the consumption
    const pricedData: PricedDimensionData = {
      unitPrice: unitPrice,
      amount,
      roundedAmount: Utils.truncTo(amount, 2),
      quantity: seconds
    };
    // Add the consumption to the previous data (if any) - for the billing
    this.addPricedData(pricingDimension, pricedData);
    // Return the current consumption!
    return pricedData;
  }

  private addPricedData(pricingDimension: PricingDimension, pricedData: PricedDimensionData): void {
    // Add the consumption to the previous data (if any) - for the billing
    const previousData = pricingDimension.pricedData;
    if (previousData) {
      previousData.amount += pricedData.amount;
      previousData.quantity += pricedData.quantity;
      previousData.roundedAmount = Utils.truncTo(previousData.amount, 2);
    } else {
      pricingDimension.pricedData = pricedData;
    }
  }
}
