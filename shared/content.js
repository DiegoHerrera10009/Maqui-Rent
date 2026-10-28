export const GUARANTEES = [
  {
    risk: "Daño o pérdida de la máquina",
    mechanism: "Depósito en garantía (preautorización) y protección de equipo. Si el acta de devolución declara un daño, el procesador captura el depósito hasta ese valor.",
  },
  {
    risk: "Incumplimiento de pago",
    mechanism: "El arrendatario paga al reservar y el procesador retiene el dinero. Se reparte al propietario solo en la liquidación, cuando ya existe acta de devolución.",
  },
  {
    risk: "Propietario falso o máquina inexistente",
    mechanism: "KYC de la persona, KYB de la empresa y verificación de propiedad con factura o registro del equipo. Sin eso el anuncio no se puede reservar.",
  },
  {
    risk: "Disputa sobre el estado del equipo",
    mechanism: "Acta digital de entrega y de devolución con fotos, horómetro, checklist, geolocalización y hash de evidencia.",
  },
  {
    risk: "Accidente a terceros",
    mechanism: "La protección incluye responsabilidad civil y la reserva exige un operador certificado cuando la máquina lo pide.",
  },
  {
    risk: "Cancelaciones",
    mechanism: "Política escalonada: reembolso total a 7 días o más, parcial entre 3 y 7, y penalidad si falta menos de 3.",
  },
  {
    risk: "Conflictos",
    mechanism: "Primero mediación dentro de la celda del contrato. Si no hay acuerdo, arbitraje o tribunales de ese país. MaquiRent no es parte del arrendamiento.",
  },
];

export const PRINCIPLES = {
  role: "MaquiRent es intermediario. El contrato de arrendamiento es entre el propietario y la empresa arrendataria. La filial local no alquila la máquina como parte.",
  custody:
    "MaquiRent no custodia el dinero del alquiler. Un procesador licenciado cobra, retiene y hace el split: propietario, asegurador, comisión de la filial y tarifa del propio procesador.",
  invoicing:
    "La filial factura su comisión al propietario y la tarifa de servicio al arrendatario. El propietario factura el arrendamiento al arrendatario. El impuesto estimado se muestra y un contador debe confirmar base y retenciones.",
  crossBorder:
    "Se puede alquilar una máquina de otro país. La celda del propietario sigue siendo la única que escribe la reserva. La cotización suma los días de ida y vuelta y el flete, y no deja elegir una entrega más pronto que el transporte. Aduana y admisión temporal van dentro de ese plazo. MaquiRent sigue siendo el intermediario: no es el arrendatario.",
  residency:
    "Cada cuenta nace en la celda de su país. El plano global guarda el anuncio y un seudónimo, nunca el correo. Si el contrato cruza la frontera, el nombre y el documento se copian a la celda de la máquina solo para ese contrato y la aduana.",
  consistency:
    "La búsqueda es eventualmente consistente: el anuncio viaja por el bus, desde la bandeja de salida de la celda. La reserva es fuertemente consistente: solo la celda del propietario escribe, en una transacción, y rechaza el solapamiento de fechas.",
  escrowTiming:
    "El cobro queda retenido al reservar. La entrega verificada demuestra que el alquiler empezó, pero el equipo sigue fuera, así que el split al propietario ocurre al liquidar, con el acta de devolución. Liberar todo el dinero en la entrega dejaría al propietario pagado antes de recuperar la máquina.",
};

export const JURY = [
  {
    q: "¿Qué pasa si se cae la celda de un país?",
    a: "Ese país deja de reservar y de cobrar. Las otras celdas siguen, porque no comparten base ni proceso. El índice global puede conservar anuncios ya replicados hasta que vuelva a recibir eventos: la búsqueda no es la fuente de la reserva.",
  },
  {
    q: "¿Cómo se evita que dos empresas reserven la misma máquina?",
    a: "La máquina tiene un solo escritor: la celda del país del propietario. La reserva y el control de fechas ocurren en la misma transacción. Un reintento con la misma clave de idempotencia no crea otra reserva ni otro cobro.",
  },
  {
    q: "¿Quién responde si la máquina se daña?",
    a: "El arrendatario responde frente al propietario según el contrato. La plataforma aporta depósito, protección de equipo y las dos actas. MaquiRent no es dueño del equipo ni parte del arrendamiento. Si hay desacuerdo, se abre mediación en el país del contrato.",
  },
  {
    q: "¿Cómo se cumple la protección de datos entre países?",
    a: "La cuenta nace en su país y el plano global no guarda correo ni documento. Las otras celdas no ven ese dato hasta que hay un contrato: entonces el nombre, el documento y el contacto se copian a la celda de la máquina, porque el contrato y la aduana los necesitan. No se copia al índice de búsqueda.",
  },
  {
    q: "¿Es rentable el 8% después de las comisiones de pago?",
    a: "El 8% no es el margen. Es la comisión al propietario. A eso se suman la tarifa de servicio al arrendatario (5%) y una parte de la protección. El procesador cobra entre 2,9% y 3,9% del importe cobrado y sale de la parte de la plataforma. El panel de confianza calcula el neto.",
  },
  {
    q: "¿Cómo se alquila una máquina que está en otro país?",
    a: "La reserva la escribe la celda del propietario. Si la cuenta está en Colombia y la máquina en Francia, el sistema suma el viaje de ida y vuelta: los días que tarda el transporte y el flete. La entrega no puede ser antes de que la máquina llegue, y el equipo sigue ocupado hasta que vuelve. El flete lo cobra el transportista; MaquiRent no se queda con ese dinero ni pasa a ser el arrendatario.",
  },
];

export const STATE_LABELS = {
  requested: "Solicitada",
  paid_held: "Pagada (retenida)",
  delivered: "Entregada",
  returned: "Devuelta",
  settled: "Liquidada",
  disputed: "En disputa",
  cancelled: "Cancelada",
};

export const CHECKLIST = [
  "Estado general sin daño nuevo",
  "Sin fugas visibles",
  "Orugas, neumáticos o estabilizadores revisados",
  "Luces, alarma y parada de emergencia",
  "Documentos del equipo a bordo",
  "Horómetro legible",
  "Accesorios y implementos completos",
];
